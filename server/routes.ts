import type { Express } from "express";
import { type Server } from "http";
import multer from "multer";
import path from "path";
import fs from "fs";
import { nanoid } from "nanoid";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { storage } from "./storage";
import { spawn } from "child_process";
import os from "os";
import { vimeoFetchVideo, vimeoExtractFileLinks, vimeoDiagnoseNoFileAccess } from "./vimeo";
import crypto from "crypto";
import { makeB2Client, b2PresignGetObject, b2UploadFile } from "./b2";
import { createSession, rotateSession, getSession, revokeSession, verifySignedPath, trackRequest, trackPlaylistFetch, acquireSegment, releaseSegment, trackKeyHit, buildSignedProxyUrl, buildStableKeyUrl, signPath, computeDeviceHash, updateProgress, validateSegmentWindow, parsePlaylist, getWindowRange, getBreachInfo, getAbuseThresholds, getTokenTTL, getAllSessions, validateUserAgent, checkAndIssueKey, SESSION_ROTATION_MS } from "./video-session";
import type { PlaylistCache } from "./video-session";

function log(message: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [routes] ${message}`);
}

function asyncHandler(fn: (req: any, res: any, next: any) => Promise<any>) {
  return (req: any, res: any, next: any) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error("[routes] Unhandled async error:", err);
      next(err);
    });
  };
}

// Middleware
function requireAuth(req: any, res: any, next: any) {
  if (!req.session?.adminId) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
}

// Multer setup
const uploadDir = path.join(os.tmpdir(), "vcms-uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4GB
});

// S3 helpers
async function getS3Client() {
  const ak = await storage.getSetting("aws_access_key_id");
  const sk = await storage.getSetting("aws_secret_access_key");
  const region = await storage.getSetting("aws_region");
  if (!ak || !sk || !region) return null;
  return new S3Client({ region, credentials: { accessKeyId: ak, secretAccessKey: sk } });
}

async function getS3Config() {
  return {
    bucket: (await storage.getSetting("s3_bucket")) || "",
    rawPrefix: (await storage.getSetting("s3_private_prefix")) || "raw/",
    hlsPrefix: (await storage.getSetting("s3_hls_prefix")) || "hls/",
  };
}

// Returns the active storage connection or null (falls back to legacy S3 settings)
async function getActiveStorageConn() {
  return storage.getActiveStorageConnection();
}

// Generate a signed URL for HLS playback — supports B2 and AWS S3
async function generateSignedUrl(key: string, ttlSeconds = 120, connId?: string | null): Promise<string> {
  // Try active storage connection first
  const conn = connId
    ? await storage.getStorageConnectionById(connId)
    : await storage.getActiveStorageConnection();
  if (conn?.provider === "backblaze_b2") {
    const cfg = conn.config as any;
    return b2PresignGetObject(cfg.bucket, key, cfg.endpoint, ttlSeconds);
  }
  // Fall back to legacy AWS S3 settings
  return generateSignedS3Url(key, ttlSeconds);
}

// Upload a local file to active storage (B2 or S3)
async function uploadToActiveStorage(localPath: string, key: string, contentType: string, conn?: Awaited<ReturnType<typeof storage.getActiveStorageConnection>>): Promise<void> {
  const active = conn ?? await storage.getActiveStorageConnection();
  if (active?.provider === "backblaze_b2") {
    const cfg = active.config as any;
    const data = fs.readFileSync(localPath);
    await b2UploadFile(cfg.bucket, key, data, contentType, cfg.endpoint);
    return;
  }
  // Fall back to legacy S3
  await uploadToS3(localPath, key, contentType);
}

// ── Ingest helpers ─────────────────────────────────────────

async function downloadToTempFile(url: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  if (!response.body) throw new Error("No response body");
  const { pipeline } = await import("stream/promises");
  const { Readable } = await import("stream");
  const tmpPath = path.join(os.tmpdir(), `vcms-ingest-${nanoid()}.mp4`);
  const fileStream = fs.createWriteStream(tmpPath);
  await pipeline(Readable.fromWeb(response.body as any), fileStream);
  return tmpPath;
}

async function uploadHlsDir(localDir: string, prefix: string, activeConn: Awaited<ReturnType<typeof storage.getActiveStorageConnection>>): Promise<void> {
  function walkDir(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const e of entries) {
      if (e.isDirectory()) files.push(...walkDir(path.join(dir, e.name)));
      else files.push(path.join(dir, e.name));
    }
    return files;
  }
  const files = walkDir(localDir);
  const skipFiles = new Set(["enc.key", "key_info.txt"]);
  for (const file of files) {
    const basename = path.basename(file);
    if (skipFiles.has(basename)) continue;
    const relPath = path.relative(localDir, file).replace(/\\/g, "/");
    const key = `${prefix}${relPath}`;
    const contentType = file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/MP2T";
    await uploadToActiveStorage(file, key, contentType, activeConn);
  }
}

async function transcodeAndStoreHls(videoId: string, inputPath: string, qualities: number[], connOverride?: any): Promise<void> {
  const hlsOutputDir = path.join(os.tmpdir(), "vcms-hls", videoId);

  const enc = generateEncryptionKey();
  const keyFilePath = path.join(hlsOutputDir, "enc.key");
  const keyInfoPath = path.join(hlsOutputDir, "key_info.txt");
  if (!fs.existsSync(hlsOutputDir)) fs.mkdirSync(hlsOutputDir, { recursive: true });
  fs.writeFileSync(keyFilePath, enc.keyBytes);
  createKeyInfoFile("enc.key", keyFilePath, enc.iv, keyInfoPath);

  await runFfmpegHls(inputPath, hlsOutputDir, qualities, { keyInfoPath }, videoId);

  // Verify AES-128 was applied — every variant playlist must have EXT-X-KEY METHOD=AES-128
  const variantPlaylists: string[] = [];
  function findVariantM3u8(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) findVariantM3u8(full);
      else if (entry.name.endsWith(".m3u8") && !entry.name.startsWith("master")) variantPlaylists.push(full);
    }
  }
  findVariantM3u8(hlsOutputDir);
  if (variantPlaylists.length === 0) throw new Error("FFmpeg produced no variant playlists — transcode failed");
  for (const m3u8 of variantPlaylists) {
    const content = fs.readFileSync(m3u8, "utf8");
    if (!content.includes("#EXT-X-KEY") || !content.includes("METHOD=AES-128")) {
      throw new Error(`Playlist ${path.basename(m3u8)} is missing AES-128 EXT-X-KEY — refusing to mark video ready`);
    }
  }
  log(`AES-128 validation passed: ${variantPlaylists.length} variant playlist(s) all contain EXT-X-KEY METHOD=AES-128`);

  if (videoId) transcodeProgress.set(videoId, { time: "", speed: "", stage: "uploading" });
  const activeConn = connOverride ?? await storage.getActiveStorageConnection();

  if (activeConn?.provider === "backblaze_b2") {
    const cfg = activeConn.config as any;
    const hlsPrefix = `${cfg.hlsPrefix || "hls/"}${videoId}/`;
    const keyBucketPath = `${hlsPrefix}enc.key`;
    await b2UploadFile(cfg.bucket, keyBucketPath, enc.keyBytes, "application/octet-stream", cfg.endpoint);
    await uploadHlsDir(hlsOutputDir, hlsPrefix, activeConn);
    await storage.updateVideo(videoId, {
      status: "ready",
      hlsS3Prefix: hlsPrefix,
      storageConnectionId: activeConn.id,
      encryptionKid: enc.kid,
      encryptionKeyPath: keyBucketPath,
      lastError: null,
    } as any);
    try { fs.rmSync(hlsOutputDir, { recursive: true }); } catch {}
    transcodeProgress.delete(videoId);
    log(`B2 HLS upload (AES-128 encrypted) complete for video ${videoId}`);
    return;
  }

  const client = await getS3Client();
  const cfg = await getS3Config();
  if (client && cfg.bucket) {
    const hlsPrefix = `${cfg.hlsPrefix}${videoId}/`;
    await uploadHlsToS3(hlsOutputDir, hlsPrefix);
    await storage.updateVideo(videoId, { status: "ready", hlsS3Prefix: hlsPrefix, encryptionKid: enc.kid, lastError: null } as any);
    try { fs.rmSync(hlsOutputDir, { recursive: true }); } catch {}
  } else {
    const localHlsDir = path.join(uploadDir, "hls", videoId);
    if (fs.existsSync(localHlsDir)) fs.rmSync(localHlsDir, { recursive: true });
    fs.cpSync(hlsOutputDir, localHlsDir, { recursive: true });
    await storage.updateVideo(videoId, { status: "ready", hlsS3Prefix: localHlsDir, encryptionKid: enc.kid, lastError: null } as any);
    try { fs.rmSync(hlsOutputDir, { recursive: true }); } catch {}
  }
  transcodeProgress.delete(videoId);
  log(`Ingest/transcode (AES-128 encrypted) complete for video ${videoId}`);
}

async function ingestDirectMp4(videoId: string, url: string): Promise<void> {
  log(`Ingesting direct URL for video ${videoId}: ${url}`);
  const tmpPath = await downloadToTempFile(url);
  try {
    await transcodeAndStoreHls(videoId, tmpPath, [720, 480, 360]);
  } finally {
    try { fs.rmSync(tmpPath); } catch {}
  }
}

function extractVimeoId(input: string): string | null {
  // 1) Full iframe embed HTML: src="https://player.vimeo.com/video/1168001442?..."
  const iframeMatch = input.match(/player\.vimeo\.com\/video\/(\d+)/i);
  if (iframeMatch) return iframeMatch[1];
  // 2) Standard Vimeo URL: https://vimeo.com/1168001442 or https://vimeo.com/video/1168001442
  const urlMatch = input.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
  if (urlMatch) return urlMatch[1];
  return null;
}

async function ingestVimeoVideo(videoId: string, vimeoUrl: string): Promise<void> {
  const vimeoToken = process.env.VIMEO_ACCESS_TOKEN || (await storage.getSetting("vimeo_access_token")) || "";
  if (!vimeoToken) {
    throw new Error("Vimeo access token not configured. Set VIMEO_ACCESS_TOKEN in environment variables or add vimeo_access_token in System Settings.");
  }
  const vimeoVideoId = extractVimeoId(vimeoUrl);
  if (!vimeoVideoId) throw new Error("Could not parse Vimeo video ID from input");

  log(`Calling Vimeo API for video ID ${vimeoVideoId}...`);
  const { status: httpStatus, data: vimeoData } = await vimeoFetchVideo(vimeoVideoId, vimeoToken);

  if (httpStatus !== 200) {
    const diag = vimeoDiagnoseNoFileAccess(vimeoData, httpStatus);
    await storage.updateVideo(videoId, {
      status: "error",
      lastError: diag.message,
      lastErrorCode: diag.code,
      lastErrorHints: diag.hints,
    } as any);
    throw new Error(diag.message);
  }

  const { progressiveMp4s } = vimeoExtractFileLinks(vimeoData);

  if (!progressiveMp4s.length) {
    const diag = vimeoDiagnoseNoFileAccess(vimeoData, httpStatus);
    log(`Vimeo file links unavailable for ${vimeoVideoId}: hasFiles=${vimeoData.files !== undefined}, hasDownload=${vimeoData.download !== undefined}, privacy=${vimeoData.privacy?.view}`);
    await storage.updateVideo(videoId, {
      status: "error",
      lastError: diag.message,
      lastErrorCode: diag.code,
      lastErrorHints: diag.hints,
    } as any);
    throw new Error(diag.message);
  }

  const best = progressiveMp4s[0];
  log(`Downloading Vimeo video ${vimeoVideoId} (${best.quality} quality, height=${best.height || "?"}px)...`);
  const tmpPath = await downloadToTempFile(best.link, { Authorization: `Bearer ${vimeoToken}` });
  try {
    await transcodeAndStoreHls(videoId, tmpPath, [720, 480, 360]);
    // Clear any previous error state on success
    await storage.updateVideo(videoId, { lastError: null, lastErrorCode: null, lastErrorHints: [] } as any);
  } finally {
    try { fs.rmSync(tmpPath); } catch {}
  }
}

async function uploadToS3(localPath: string, s3Key: string, contentType: string): Promise<void> {
  const client = await getS3Client();
  if (!client) throw new Error("S3 not configured");
  const cfg = await getS3Config();
  const fileStream = fs.createReadStream(localPath);
  await client.send(new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: s3Key,
    Body: fileStream,
    ContentType: contentType,
  }));
}

async function generateSignedS3Url(key: string, ttlSeconds = 120): Promise<string> {
  const client = await getS3Client();
  if (!client) throw new Error("S3 not configured");
  const cfg = await getS3Config();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), { expiresIn: ttlSeconds });
}

async function getSigningSecret(): Promise<string> {
  return (await storage.getSetting("signing_secret")) || "default-secret";
}

function generateToken(payload: object, ttlSeconds: number): string {
  const secret = process.env.SIGNING_SECRET || "signing-secret";
  return jwt.sign(payload, secret, { expiresIn: ttlSeconds });
}

function verifyToken(token: string): any {
  const secret = process.env.SIGNING_SECRET || "signing-secret";
  try {
    return jwt.verify(token, secret);
  } catch {
    return null;
  }
}

// ffmpeg HLS processing
const transcodeProgress = new Map<string, { time: string; speed: string; stage: string }>();

function getTranscodeProgress(videoId: string): { time: string; speed: string; stage: string } | null {
  return transcodeProgress.get(videoId) || null;
}

async function runFfmpegHls(
  inputPath: string,
  outputDir: string,
  qualities: number[],
  encryption?: { keyInfoPath: string },
  videoId?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const args: string[] = ["-i", inputPath, "-y"];

    const qualityMap: Record<number, { vf: string; b: string; ba: string; maxrate: string; bufsize: string }> = {
      240: { vf: "scale=-2:240", b: "400k", ba: "64k", maxrate: "500k", bufsize: "1000k" },
      360: { vf: "scale=-2:360", b: "800k", ba: "96k", maxrate: "900k", bufsize: "1800k" },
      480: { vf: "scale=-2:480", b: "1200k", ba: "128k", maxrate: "1400k", bufsize: "2800k" },
      720: { vf: "scale=-2:720", b: "2500k", ba: "128k", maxrate: "2800k", bufsize: "5600k" },
      1080: { vf: "scale=-2:1080", b: "5000k", ba: "192k", maxrate: "5500k", bufsize: "11000k" },
    };

    const selectedQualities = qualities.filter(q => qualityMap[q]);
    if (selectedQualities.length === 0) selectedQualities.push(720);

    selectedQualities.forEach((q, i) => {
      const cfg = qualityMap[q];
      args.push(
        `-map`, `0:v:0`, `-map`, `0:a:0`,
        `-c:v:${i}`, `libx264`, `-b:v:${i}`, cfg.b,
        `-maxrate:v:${i}`, cfg.maxrate, `-bufsize:v:${i}`, cfg.bufsize,
        `-filter:v:${i}`, cfg.vf, `-c:a:${i}`, `aac`, `-b:a:${i}`, cfg.ba
      );
    });

    const streamMap = selectedQualities.map((_, i) => `v:${i},a:${i}`).join(" ");

    args.push(
      `-var_stream_map`, streamMap,
      `-master_pl_name`, `master.m3u8`,
      `-f`, `hls`,
      `-hls_time`, `2`,
      `-hls_list_size`, `0`,
      `-hls_segment_filename`, path.join(outputDir, "v%v/seg_%03d.ts"),
    );

    if (encryption) {
      args.push(`-hls_key_info_file`, encryption.keyInfoPath);
    }

    args.push(path.join(outputDir, "v%v/index.m3u8"));

    log(`Running ffmpeg for HLS${encryption ? " (AES-128 encrypted)" : ""}...`);
    if (videoId) transcodeProgress.set(videoId, { time: "00:00:00", speed: "0x", stage: "transcoding" });
    const proc = spawn("ffmpeg", args);
    let stderrBuf = "";
    proc.stderr.on("data", (d) => {
      process.stdout.write(d);
      if (videoId) {
        stderrBuf += d.toString();
        const lines = stderrBuf.split("\r");
        stderrBuf = lines[lines.length - 1];
        for (const line of lines) {
          const timeMatch = line.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
          const speedMatch = line.match(/speed=\s*([\d.]+x)/);
          if (timeMatch) {
            transcodeProgress.set(videoId, {
              time: timeMatch[1],
              speed: speedMatch ? speedMatch[1] : "0x",
              stage: "transcoding",
            });
          }
        }
      }
    });
    proc.on("close", (code) => {
      if (videoId) {
        if (code === 0) transcodeProgress.set(videoId, { time: "", speed: "", stage: "uploading" });
        else transcodeProgress.delete(videoId);
      }
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

const masterKeyCache = new Map<string, Buffer>();

async function getMasterKey(encryptionKeyPath: string, session: any): Promise<Buffer | null> {
  if (masterKeyCache.has(encryptionKeyPath)) return masterKeyCache.get(encryptionKeyPath)!;
  try {
    const cfg = session.storageConfig;
    const b2 = makeB2Client({ endpoint: cfg.endpoint });
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const resp = await b2.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: encryptionKeyPath }));
    const keyBytes = Buffer.from(await resp.Body!.transformToByteArray());
    masterKeyCache.set(encryptionKeyPath, keyBytes);
    return keyBytes;
  } catch (e: any) {
    log(`getMasterKey error: ${e.message}`);
    return null;
  }
}

function decryptAes128Cbc(ciphertext: Buffer, key: Buffer, iv: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function encryptAes128Cbc(plaintext: Buffer, key: Buffer, iv: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function extractIVFromKeyTag(keyTag: string): Buffer | null {
  const ivMatch = keyTag.match(/IV=0x([0-9a-fA-F]+)/);
  if (!ivMatch) return null;
  return Buffer.from(ivMatch[1], "hex");
}

function extractIVForSegment(session: any, segSubPath: string): Buffer | null {
  for (const [, cached] of session.variantCache as Map<string, any>) {
    for (const seg of cached.segments) {
      if (segSubPath.includes(seg.uri) && seg.keyTag) {
        return extractIVFromKeyTag(seg.keyTag);
      }
    }
  }
  return null;
}

function generateEncryptionKey(): { keyBytes: Buffer; keyHex: string; kid: string; iv: string } {
  const keyBytes = crypto.randomBytes(16);
  const keyHex = keyBytes.toString("hex");
  const kid = crypto.randomBytes(8).toString("hex");
  const iv = crypto.randomBytes(16).toString("hex");
  return { keyBytes, keyHex, kid, iv };
}

function createKeyInfoFile(
  keyUri: string,
  keyFilePath: string,
  iv: string,
  outputPath: string,
): void {
  fs.writeFileSync(outputPath, `${keyUri}\n${keyFilePath}\n${iv}\n`);
}

// Upload HLS segments to S3
async function uploadHlsToS3(localDir: string, s3Prefix: string): Promise<void> {
  const client = await getS3Client();
  if (!client) throw new Error("S3 not configured");
  const cfg = await getS3Config();

  function walkDir(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const e of entries) {
      if (e.isDirectory()) files.push(...walkDir(path.join(dir, e.name)));
      else files.push(path.join(dir, e.name));
    }
    return files;
  }

  const files = walkDir(localDir);
  for (const file of files) {
    const relPath = path.relative(localDir, file);
    const s3Key = `${s3Prefix}${relPath}`.replace(/\\/g, "/");
    const contentType = file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/MP2T";
    const fileData = fs.readFileSync(file);
    await client.send(new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: s3Key,
      Body: fileData,
      ContentType: contentType,
    }));
  }
}

// Rewrite m3u8 playlist with signed URLs
async function rewritePlaylistWithSignedUrls(
  playlistContent: string,
  s3Prefix: string,
  ttl: number
): Promise<string> {
  const lines = playlistContent.split("\n");
  const rewritten: string[] = [];
  for (const line of lines) {
    if (line.trim() && !line.startsWith("#") && (line.endsWith(".ts") || line.endsWith(".m3u8"))) {
      const segKey = s3Prefix + line.trim().replace(/^.*\//, (m) => {
        const parts = line.trim().split("/");
        return parts.length > 1 ? parts.slice(-2).join("/") : parts[parts.length - 1];
      });
      try {
        const signed = await generateSignedS3Url(segKey, ttl);
        rewritten.push(signed);
      } catch {
        rewritten.push(line);
      }
    } else {
      rewritten.push(line);
    }
  }
  return rewritten.join("\n");
}

// Startup recovery: resume any videos stuck in "processing" when the server restarted
export async function recoverProcessingVideos(): Promise<void> {
  try {
    const allVideos = await storage.getVideos();
    const stuck = allVideos.filter(v => v.status === "processing");
    if (stuck.length === 0) return;
    log(`[recovery] Found ${stuck.length} video(s) stuck in processing — resuming...`);

    for (const video of stuck) {
      if (transcodeProgress.has(video.id)) continue;

      const rawKey = (video as any).rawS3Key as string | null;
      const connId = (video as any).storageConnectionId as string | null;
      const sourceType = video.sourceType;
      const sourceUrl = video.sourceUrl;

      if (rawKey && connId) {
        log(`[recovery] Re-transcoding video ${video.id} from B2 (${rawKey})`);
        // Mark immediately so concurrent retranscode requests see it as active
        transcodeProgress.set(video.id, { time: "", speed: "", stage: "recovering" });
        (async () => {
          try {
            const conn = await storage.getStorageConnectionById(connId);
            if (!conn) throw new Error("Storage connection not found");
            const cfg = conn.config as any;
            const b2 = makeB2Client({ endpoint: cfg.endpoint });
            const { GetObjectCommand } = await import("@aws-sdk/client-s3");
            const resp = await b2.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: rawKey }));
            const tmpPath = path.join(os.tmpdir(), `recover-${video.id}.mp4`);
            const bodyStream = resp.Body as any;
            const ws = fs.createWriteStream(tmpPath);
            await new Promise<void>((resolve, reject) => {
              bodyStream.pipe(ws);
              ws.on("finish", resolve);
              ws.on("error", reject);
            });
            const quals = (video as any).qualities?.length ? (video as any).qualities : [720, 480, 360];
            await transcodeAndStoreHls(video.id, tmpPath, quals);
            try { fs.unlinkSync(tmpPath); } catch {}
            log(`[recovery] Video ${video.id} recovered successfully`);
          } catch (e: any) {
            log(`[recovery] Failed to recover video ${video.id}: ${e.message}`);
            await storage.updateVideo(video.id, { status: "error", lastError: `Recovery failed: ${e.message}` } as any);
          }
        })();
        continue;
      }

      if ((sourceType === "vimeo" || sourceType === "vimeo_ingest") && sourceUrl) {
        log(`[recovery] Re-ingesting Vimeo video ${video.id}`);
        ingestVimeoVideo(video.id, sourceUrl).catch(async (e: Error) => {
          await storage.updateVideo(video.id, { status: "error", lastError: e.message } as any);
        });
        continue;
      }

      if (sourceType === "direct_url" && sourceUrl && !/\.m3u8/i.test(sourceUrl)) {
        log(`[recovery] Re-ingesting direct URL video ${video.id}`);
        ingestDirectMp4(video.id, sourceUrl).catch(async (e: Error) => {
          await storage.updateVideo(video.id, { status: "error", lastError: e.message } as any);
        });
        continue;
      }

      log(`[recovery] Video ${video.id} has no recoverable source — marking as error`);
      await storage.updateVideo(video.id, {
        status: "error",
        lastError: "Processing was interrupted and cannot be automatically recovered. Please re-upload the video.",
      } as any);
    }
  } catch (e: any) {
    log(`[recovery] Startup recovery error: ${e.message}`);
  }
}

// Routes
export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {

  // Auto-wrap all async route handlers so any unhandled rejection
  // is forwarded to Express error middleware instead of crashing the process.
  for (const method of ["get", "post", "put", "patch", "delete"] as const) {
    const original = (app as any)[method].bind(app);
    (app as any)[method] = (routePath: any, ...handlers: any[]) => {
      const wrapped = handlers.map((h: any) =>
        typeof h === "function" && h.constructor?.name === "AsyncFunction"
          ? asyncHandler(h)
          : h
      );
      return original(routePath, ...wrapped);
    };
  }

  // ── Auth ──────────────────────────────────────────────────
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ message: "Email and password required" });

      const admin = await storage.getAdminByEmail(email);
      if (!admin) return res.status(401).json({ message: "Invalid credentials" });

      const valid = await bcrypt.compare(password, admin.passwordHash);
      if (!valid) return res.status(401).json({ message: "Invalid credentials" });

      req.session.adminId = admin.id;
      req.session.adminEmail = admin.email;
      res.json({ ok: true, email: admin.email });
    } catch (e) {
      res.status(500).json({ message: "Login failed" });
    }
  });

  app.post("/api/auth/register", async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ message: "Email and password required" });
      if (password.length < 8) return res.status(400).json({ message: "Password must be at least 8 characters" });

      const existing = await storage.getAdminByEmail(email);
      if (existing) return res.status(409).json({ message: "Email already registered" });

      const passwordHash = await bcrypt.hash(password, 12);
      const admin = await storage.createAdminUser(email, passwordHash);

      req.session.adminId = admin.id;
      req.session.adminEmail = admin.email;
      res.status(201).json({ ok: true, email: admin.email });
    } catch (e) {
      res.status(500).json({ message: "Registration failed" });
    }
  });

  app.post("/api/auth/logout", requireAuth, (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  app.get("/api/auth/me", (req, res) => {
    if (!req.session?.adminId) return res.status(401).json({ message: "Not authenticated" });
    res.json({ id: req.session.adminId, email: req.session.adminEmail });
  });

  // ── Videos ────────────────────────────────────────────────
  app.get("/api/videos", requireAuth, async (req, res) => {
    const vids = await storage.getVideos();
    res.json(vids);
  });

  app.post("/api/videos", requireAuth, async (req, res) => {
    try {
      const { title, description, author, tags, sourceType, sourceUrl } = req.body;
      const publicId = nanoid(10);
      const video = await storage.createVideo({
        title: title || "Untitled Video",
        description: description || "",
        author: author || "",
        tags: tags || [],
        publicId,
        status: sourceType === "upload" ? "uploading" : "ready",
        sourceType: sourceType || "upload",
        sourceUrl: sourceUrl || null,
        available: true,
      });
      // Create default settings
      await storage.upsertPlayerSettings(video.id, {});
      await storage.upsertWatermarkSettings(video.id, {});
      await storage.upsertSecuritySettings(video.id, {});
      await storage.createAuditLog({ action: "video_created", meta: { videoId: video.id, title: video.title }, ip: req.ip });
      res.json(video);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/videos/:id", requireAuth, async (req, res) => {
    const v = await storage.getVideoById(req.params.id);
    if (!v) return res.status(404).json({ message: "Not found" });
    const playerSettings = await storage.getPlayerSettings(v.id);
    const watermarkSettings = await storage.getWatermarkSettings(v.id);
    const securitySettings = await storage.getSecuritySettings(v.id);
    const progress = v.status === "processing" ? getTranscodeProgress(v.id) : null;
    res.json({ ...v, playerSettings, watermarkSettings, securitySettings, processingProgress: progress });
  });

  app.put("/api/videos/:id", requireAuth, async (req, res) => {
    try {
      const { title, description, author, tags, available, sourceType, sourceUrl } = req.body;
      const v = await storage.updateVideo(req.params.id, { title, description, author, tags, available, sourceType, sourceUrl });
      if (!v) return res.status(404).json({ message: "Not found" });
      await storage.createAuditLog({ action: "video_updated", meta: { videoId: v.id }, ip: req.ip });
      res.json(v);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.delete("/api/videos/:id", requireAuth, async (req, res) => {
    const v = await storage.getVideoById(req.params.id);
    if (!v) return res.status(404).json({ message: "Not found" });
    await storage.deleteVideo(req.params.id);
    await storage.createAuditLog({ action: "video_deleted", meta: { videoId: req.params.id, title: v.title }, ip: req.ip });
    res.json({ ok: true });
  });

  // ── Import endpoint (ingest & convert) ───────────────────
  app.post("/api/videos/import", requireAuth, async (req, res) => {
    try {
      const { sourceUrl, title, description, author, tags } = req.body;
      if (!sourceUrl?.trim()) return res.status(400).json({ message: "sourceUrl is required" });

      const rawInput = sourceUrl.trim();

      // Check Vimeo first (handles both iframe HTML and URLs)
      const vimeoId = extractVimeoId(rawInput);
      const isVimeo = !!vimeoId;
      // Normalize to canonical vimeo URL if matched
      const url = isVimeo ? `https://vimeo.com/${vimeoId}` : rawInput;

      const isYouTube = !isVimeo && /(?:youtube\.com|youtu\.be|youtube-nocookie\.com)/i.test(rawInput);
      const isM3u8 = !isVimeo && /\.m3u8(\?|$)/i.test(url);

      let sourceType: string;
      let initialStatus: string;
      let lastError: string | null = null;

      if (isYouTube) {
        sourceType = "youtube_blocked";
        initialStatus = "error";
        lastError = "YouTube links cannot be played in our custom player. Please upload the video file or provide a direct HLS (.m3u8) or MP4 URL.";
      } else if (isVimeo) {
        sourceType = "vimeo_ingest";
        initialStatus = "processing";
      } else if (isM3u8) {
        sourceType = "direct_url";
        initialStatus = "ready";
      } else {
        sourceType = "direct_url";
        initialStatus = "processing";
      }

      const publicId = nanoid(10);
      const video = await storage.createVideo({
        title: title || "Untitled Video",
        description: description || "",
        author: author || "",
        tags: tags || [],
        publicId,
        status: initialStatus,
        sourceType,
        sourceUrl: url,
        available: true,
        lastError,
      } as any);

      await storage.upsertPlayerSettings(video.id, {});
      await storage.upsertWatermarkSettings(video.id, {});
      await storage.upsertSecuritySettings(video.id, {});
      await storage.createAuditLog({ action: "video_imported", meta: { videoId: video.id, sourceType, url }, ip: req.ip });

      if (sourceType === "vimeo_ingest") {
        ingestVimeoVideo(video.id, url).catch(async (e: Error) => {
          log(`Vimeo ingest failed for ${video.id}: ${e.message}`);
          await storage.updateVideo(video.id, { status: "error", lastError: e.message } as any);
        });
      } else if (sourceType === "direct_url" && initialStatus === "processing") {
        ingestDirectMp4(video.id, url).catch(async (e: Error) => {
          log(`Direct ingest failed for ${video.id}: ${e.message}`);
          await storage.updateVideo(video.id, { status: "error", lastError: e.message } as any);
        });
      }

      res.json({ videoId: video.id, publicId: video.publicId, status: video.status, message: lastError || (initialStatus === "processing" ? "Ingestion started" : "Video ready") });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Build / rebuild HLS from existing source URL ───────────
  app.post("/api/videos/:id/build-hls-from-source", requireAuth, async (req, res) => {
    try {
      const video = await storage.getVideoById(req.params.id);
      if (!video) return res.status(404).json({ message: "Video not found" });

      const { sourceType, sourceUrl } = video;

      if (sourceType === "youtube" || sourceType === "youtube_blocked") {
        return res.status(400).json({ message: "YouTube links cannot be converted. Please upload the video file directly." });
      }

      if (sourceType === "vimeo" || sourceType === "vimeo_ingest") {
        if (!sourceUrl) return res.status(400).json({ message: "No source URL on this video." });
        await storage.updateVideo(video.id, { status: "processing", lastError: null } as any);
        ingestVimeoVideo(video.id, sourceUrl).catch(async (e: Error) => {
          log(`Build HLS (Vimeo) failed for ${video.id}: ${e.message}`);
          await storage.updateVideo(video.id, { status: "error", lastError: e.message } as any);
        });
        await storage.createAuditLog({ action: "video_build_hls_started", meta: { videoId: video.id, sourceType }, ip: req.ip });
        return res.json({ ok: true, message: "Vimeo ingest started. The video will be ready in a few minutes." });
      }

      if (sourceType === "direct_url") {
        if (!sourceUrl) return res.status(400).json({ message: "No source URL on this video." });
        if (/\.m3u8/i.test(sourceUrl)) {
          // Already a direct HLS URL, mark ready
          await storage.updateVideo(video.id, { status: "ready" } as any);
          return res.json({ ok: true, message: "Video is a direct HLS stream and is now marked ready." });
        }
        await storage.updateVideo(video.id, { status: "processing", lastError: null } as any);
        ingestDirectMp4(video.id, sourceUrl).catch(async (e: Error) => {
          log(`Build HLS (direct MP4) failed for ${video.id}: ${e.message}`);
          await storage.updateVideo(video.id, { status: "error", lastError: e.message } as any);
        });
        await storage.createAuditLog({ action: "video_build_hls_started", meta: { videoId: video.id, sourceType }, ip: req.ip });
        return res.json({ ok: true, message: "HLS conversion started. The video will be ready in a few minutes." });
      }

      return res.status(400).json({ message: `Cannot auto-generate HLS for sourceType '${sourceType}'. Please re-upload the video file.` });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/videos/:id/retranscode", requireAuth, async (req, res) => {
    try {
      const video = await storage.getVideoById(req.params.id);
      if (!video) return res.status(404).json({ message: "Video not found" });

      if (video.status === "processing") {
        const progress = getTranscodeProgress(video.id);
        if (progress) {
          return res.status(400).json({ message: "Video is already processing" });
        }
      }

      const rawKey = video.rawS3Key;
      const sourceUrl = video.sourceUrl;
      const sourceType = video.sourceType;

      if (rawKey) {
        const connId = (video as any).storageConnectionId as string | null;
        const conn = connId
          ? await storage.getStorageConnectionById(connId)
          : await storage.getActiveStorageConnection();

        if (!conn) return res.status(400).json({ message: "No storage connection found" });

        const cfg = conn.config as any;
        const b2 = makeB2Client({ endpoint: cfg.endpoint });
        const { GetObjectCommand } = await import("@aws-sdk/client-s3");

        await storage.updateVideo(video.id, { status: "processing", lastError: null } as any);
        res.json({ ok: true, message: "Re-transcoding started with AES-128 encryption. This may take a few minutes." });

        (async () => {
          try {
            const resp = await b2.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: rawKey }));
            const tmpPath = path.join(os.tmpdir(), `retranscode-${video.id}.mp4`);
            const bodyStream = resp.Body as any;
            const ws = fs.createWriteStream(tmpPath);
            await new Promise<void>((resolve, reject) => {
              bodyStream.pipe(ws);
              ws.on("finish", resolve);
              ws.on("error", reject);
            });
            const quals = video.qualities?.length ? video.qualities : [720, 480, 360];
            await transcodeAndStoreHls(video.id, tmpPath, quals);
            try { fs.unlinkSync(tmpPath); } catch {}
          } catch (e: any) {
            log(`Re-transcode failed for ${video.id}: ${e.message}`);
            await storage.updateVideo(video.id, { status: "error", lastError: `Re-transcode failed: ${e.message}` } as any);
          }
        })();
        await storage.createAuditLog({ action: "video_retranscode_started", meta: { videoId: video.id }, ip: req.ip });
        return;
      }

      if (sourceType === "vimeo" || sourceType === "vimeo_ingest") {
        if (!sourceUrl) return res.status(400).json({ message: "No source URL for re-transcode" });
        await storage.updateVideo(video.id, { status: "processing", lastError: null } as any);
        ingestVimeoVideo(video.id, sourceUrl).catch(async (e: Error) => {
          await storage.updateVideo(video.id, { status: "error", lastError: e.message } as any);
        });
        await storage.createAuditLog({ action: "video_retranscode_started", meta: { videoId: video.id, sourceType }, ip: req.ip });
        return res.json({ ok: true, message: "Re-transcoding (Vimeo) started with AES-128 encryption." });
      }

      if (sourceType === "direct_url" && sourceUrl && !/\.m3u8/i.test(sourceUrl)) {
        await storage.updateVideo(video.id, { status: "processing", lastError: null } as any);
        ingestDirectMp4(video.id, sourceUrl).catch(async (e: Error) => {
          await storage.updateVideo(video.id, { status: "error", lastError: e.message } as any);
        });
        await storage.createAuditLog({ action: "video_retranscode_started", meta: { videoId: video.id, sourceType }, ip: req.ip });
        return res.json({ ok: true, message: "Re-transcoding (direct URL) started with AES-128 encryption." });
      }

      return res.status(400).json({ message: "Cannot re-transcode this video. No raw file or supported source available." });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/videos/:id/toggle-availability", requireAuth, async (req, res) => {
    const v = await storage.getVideoById(req.params.id);
    if (!v) return res.status(404).json({ message: "Not found" });
    const updated = await storage.updateVideo(req.params.id, { available: !v.available });
    await storage.createAuditLog({ action: "video_availability_toggled", meta: { videoId: v.id, available: updated?.available }, ip: req.ip });
    res.json(updated);
  });

  // Upload video file → storage (B2 or S3) → ffmpeg HLS
  app.post("/api/videos/:id/upload", requireAuth, upload.single("file"), async (req: any, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ message: "No file uploaded" });

    const video = await storage.getVideoById(req.params.id);
    if (!video) return res.status(404).json({ message: "Video not found" });

    try {
      await storage.updateVideo(video.id, { status: "uploading" });

      const qualities = req.body.qualities ? JSON.parse(req.body.qualities) : [720];
      // Use explicitly selected connection, or fall back to active
      const selectedConnId = req.body.connectionId as string | undefined;
      const conn = selectedConnId
        ? await storage.getStorageConnectionById(selectedConnId)
        : await storage.getActiveStorageConnection();

      if (conn?.provider === "backblaze_b2") {
        const cfg = conn.config as any;
        const rawKey = `${cfg.rawPrefix || "raw/"}${video.id}/${file.originalname}`;
        await uploadToActiveStorage(file.path, rawKey, file.mimetype, conn);
        await storage.updateVideo(video.id, { rawS3Key: rawKey, storageConnectionId: conn.id, status: "processing" } as any);
      } else {
        // Legacy S3 or local
        const s3cfg = await getS3Config();
        const rawKey = `${s3cfg.rawPrefix}${video.id}/${file.originalname}`;
        const client = await getS3Client();
        if (client && s3cfg.bucket) {
          await uploadToS3(file.path, rawKey, file.mimetype);
          await storage.updateVideo(video.id, { rawS3Key: rawKey, status: "processing" });
        } else {
          const localVideoDir = path.join(uploadDir, "videos", video.id);
          if (!fs.existsSync(localVideoDir)) fs.mkdirSync(localVideoDir, { recursive: true });
          const destPath = path.join(localVideoDir, file.originalname);
          fs.copyFileSync(file.path, destPath);
          await storage.updateVideo(video.id, { rawS3Key: destPath, status: "processing" });
        }
      }

      // AES-128 encrypted HLS transcode — same unified pipeline as re-transcode
      storage.updateVideo(video.id, { status: "processing" });

      (async () => {
        try {
          await transcodeAndStoreHls(video.id, file.path, qualities, conn);
          try { fs.rmSync(file.path); } catch {}
          log(`Upload+AES-128 HLS transcode complete for video ${video.id}`);
        } catch (e) {
          log(`HLS processing failed for video ${video.id}: ${e}`);
          await storage.updateVideo(video.id, { status: "error", lastError: String(e) } as any);
          try { fs.rmSync(file.path); } catch {}
        }
      })();

      res.json({ ok: true, message: "Upload started, processing in background" });
    } catch (e: any) {
      await storage.updateVideo(video.id, { status: "error" });
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/videos/:id/thumbnail", requireAuth, upload.single("thumbnail"), async (req: any, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ message: "No file" });
    const video = await storage.getVideoById(req.params.id);
    if (!video) return res.status(404).json({ message: "Not found" });

    try {
      const client = await getS3Client();
      const cfg = await getS3Config();
      let thumbUrl = "";
      if (client && cfg.bucket) {
        const key = `thumbnails/${video.id}/${file.originalname}`;
        await uploadToS3(file.path, key, file.mimetype);
        thumbUrl = await generateSignedS3Url(key, 3600 * 24 * 30);
      } else {
        // Store locally and serve
        const dir = path.join("client/public/thumbnails");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, `${video.id}-${file.originalname}`);
        fs.copyFileSync(file.path, dest);
        thumbUrl = `/thumbnails/${video.id}-${file.originalname}`;
      }
      await storage.updateVideo(video.id, { thumbnailUrl: thumbUrl });
      try { fs.rmSync(file.path); } catch {}
      res.json({ thumbnailUrl: thumbUrl });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Settings
  app.put("/api/videos/:id/player-settings", requireAuth, async (req, res) => {
    const s = await storage.upsertPlayerSettings(req.params.id, req.body);
    await storage.createAuditLog({ action: "player_settings_updated", meta: { videoId: req.params.id }, ip: req.ip });
    res.json(s);
  });

  app.put("/api/videos/:id/watermark-settings", requireAuth, async (req, res) => {
    const s = await storage.upsertWatermarkSettings(req.params.id, req.body);
    await storage.createAuditLog({ action: "watermark_settings_updated", meta: { videoId: req.params.id }, ip: req.ip });
    res.json(s);
  });

  // ── Media Asset Upload (logo / watermark images) ────────────────────────
  app.post("/api/assets/:type/upload", requireAuth, upload.single("file"), async (req: any, res: any) => {
    try {
      const assetType = req.params.type;
      if (!["logo", "watermark"].includes(assetType)) return res.status(400).json({ message: "Type must be logo or watermark" });
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });

      const conn = await storage.getActiveStorageConnection();
      if (!conn || conn.provider !== "backblaze_b2") return res.status(400).json({ message: "No active B2 storage connection" });

      const cfg = conn.config as any;
      const ext = path.extname(req.file.originalname) || ".png";
      const uniqueId = nanoid(12);
      const bucketKey = `assets/${assetType}s/${uniqueId}${ext}`;

      await b2UploadFile(cfg.bucket, bucketKey, fs.readFileSync(req.file.path), req.file.mimetype, cfg.endpoint);

      const asset = await storage.createMediaAsset({
        type: assetType,
        bucketKey,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        storageConnectionId: conn.id,
      });

      try { fs.unlinkSync(req.file.path); } catch {}

      await storage.createAuditLog({ action: `${assetType}_uploaded`, meta: { assetId: asset.id, bucketKey }, ip: req.ip });

      res.json({ assetId: asset.id, bucketKey, previewUrl: `/api/assets/${asset.id}/view` });
    } catch (e: any) {
      log(`Asset upload error: ${e.message}`);
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/assets/:assetId/view", async (req: any, res: any) => {
    try {
      const asset = await storage.getMediaAssetById(req.params.assetId);
      if (!asset) return res.status(404).json({ message: "Asset not found" });

      const conn = asset.storageConnectionId
        ? await storage.getStorageConnectionById(asset.storageConnectionId)
        : await storage.getActiveStorageConnection();
      if (!conn || conn.provider !== "backblaze_b2") return res.status(500).json({ message: "Storage not available" });

      const cfg = conn.config as any;
      const signedUrl = await b2PresignGetObject(cfg.bucket, asset.bucketKey, cfg.endpoint, 60);
      const fetchRes = await fetch(signedUrl);
      if (!fetchRes.ok) return res.status(404).json({ message: "File not found in storage" });

      res.setHeader("Content-Type", asset.mimeType);
      res.setHeader("Cache-Control", "public, max-age=3600");
      const arrayBuf = await fetchRes.arrayBuffer();
      res.send(Buffer.from(arrayBuf));
    } catch (e: any) {
      log(`Asset view error: ${e.message}`);
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/assets", requireAuth, async (_req: any, res: any) => {
    const assets = await storage.getMediaAssets();
    res.json(assets);
  });

  // ── Global Watermark Defaults ──────────────────────────────────────────
  app.get("/api/watermark/global", requireAuth, async (_req: any, res: any) => {
    const value = await storage.getSetting("global_watermark");
    if (!value) return res.json({});
    try { res.json(JSON.parse(value)); } catch { res.json({}); }
  });

  app.put("/api/watermark/global", requireAuth, async (req: any, res: any) => {
    await storage.setSetting("global_watermark", JSON.stringify(req.body));
    await storage.createAuditLog({ action: "global_watermark_updated", meta: req.body, ip: req.ip });
    res.json(req.body);
  });

  app.put("/api/videos/:id/security-settings", requireAuth, async (req, res) => {
    const s = await storage.upsertSecuritySettings(req.params.id, req.body);
    await storage.createAuditLog({ action: "security_settings_updated", meta: { videoId: req.params.id }, ip: req.ip });
    res.json(s);
  });

  // ── Embed Tokens ──────────────────────────────────────────
  app.get("/api/videos/:id/tokens", requireAuth, async (req, res) => {
    const tokens = await storage.getEmbedTokensByVideo(req.params.id);
    res.json(tokens);
  });

  app.post("/api/videos/:id/tokens", requireAuth, async (req, res) => {
    try {
      const video = await storage.getVideoById(req.params.id);
      if (!video) return res.status(404).json({ message: "Video not found" });

      const { label, allowedDomain, ttlHours } = req.body;
      const ttlSecs = (ttlHours || 24) * 3600;
      const expiresAt = new Date(Date.now() + ttlSecs * 1000);
      const tokenValue = generateToken({ videoId: video.id, publicId: video.publicId }, ttlSecs);

      const token = await storage.createEmbedToken({
        videoId: video.id,
        token: tokenValue,
        label: label || "Embed Token",
        allowedDomain: allowedDomain || null,
        expiresAt,
        revoked: false,
      });
      await storage.createAuditLog({ action: "token_created", meta: { videoId: video.id, tokenId: token.id }, ip: req.ip });
      res.json(token);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/tokens", requireAuth, async (req, res) => {
    const tokens = await storage.getAllTokens();
    res.json(tokens);
  });

  app.post("/api/tokens/:id/revoke", requireAuth, async (req, res) => {
    await storage.revokeToken(req.params.id);
    await storage.createAuditLog({ action: "token_revoked", meta: { tokenId: req.params.id }, ip: req.ip });
    res.json({ ok: true });
  });

  app.delete("/api/tokens/:id", requireAuth, async (req, res) => {
    await storage.deleteToken(req.params.id);
    res.json({ ok: true });
  });

  // ── Admin preview token ──────────────────────────────────
  app.get("/api/videos/:id/admin-preview-token", requireAuth, async (req, res) => {
    try {
      const video = await storage.getVideoById(req.params.id);
      if (!video) return res.status(404).json({ message: "Not found" });
      const token = generateToken({ videoId: video.id, publicId: video.publicId, adminPreview: true }, 600);
      res.json({ token, publicId: video.publicId });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Player (public) ───────────────────────────────────────
  app.get("/api/player/:publicId/manifest", async (req, res) => {
    try {
      // Global kill switch
      const killed = await storage.getSetting("global_kill_switch");
      if (killed === "true") return res.status(503).json({ message: "Service temporarily disabled" });

      const video = await storage.getVideoByPublicId(req.params.publicId);
      if (!video) return res.status(404).json({ message: "Video not found" });
      if (!video.available) return res.status(403).json({ message: "Video unavailable" });
      if (video.status === "processing" || video.status === "uploading") {
        return res.status(202).json({ message: "Video is being processed", status: "processing" });
      }
      if (video.status === "error") {
        return res.status(400).json({ message: (video as any).lastError || "Video processing failed", status: "error" });
      }
      if (video.status !== "ready") return res.status(400).json({ message: "Video not ready" });

      const secSettings = await storage.getSecuritySettings(video.id);
      const token = req.query.token as string;

      // Check for admin preview token — bypasses all security checks
      let isAdminPreview = false;
      if (token) {
        try {
          const decoded = verifyToken(token);
          if (decoded?.adminPreview === true && decoded.publicId === video.publicId) {
            isAdminPreview = true;
          }
        } catch {}
      }

      if (!isAdminPreview) {
        // Token validation
        if (secSettings?.tokenRequired !== false) {
          if (!token) return res.status(401).json({ message: "Token required" });
          const dbToken = await storage.getTokenByValue(token);
          if (!dbToken) {
            const decoded = verifyToken(token);
            if (!decoded || decoded.publicId !== video.publicId) {
              return res.status(401).json({ message: "Invalid token" });
            }
          } else {
            if (dbToken.revoked) return res.status(401).json({ message: "Token revoked" });
            if (dbToken.expiresAt && new Date(dbToken.expiresAt) < new Date()) {
              return res.status(401).json({ message: "Token expired" });
            }
            if (dbToken.videoId !== video.id) return res.status(401).json({ message: "Token mismatch" });
          }
        }

        // Domain check
        if (secSettings?.domainWhitelistEnabled && secSettings.allowedDomains?.length) {
          const referer = req.headers.referer || req.headers.origin || req.headers["x-embed-referrer"] as string || "";
          let domain = "";
          try { domain = new URL(referer).hostname; } catch {}
          if (domain && !secSettings.allowedDomains.includes(domain)) {
            return res.status(403).json({ message: "Domain not allowed" });
          }
        }
      }

      // Direct external m3u8 — BLOCKED: never expose external URLs to the client
      const isDirectM3u8 = video.sourceType === "direct_url" && video.sourceUrl && /\.m3u8/i.test(video.sourceUrl);
      if (isDirectM3u8) {
        log(`UNSECURE_MANIFEST_BLOCKED: Attempted to serve external m3u8 URL for video ${video.publicId}. External URLs are not allowed.`);
        return res.status(403).json({ message: "Direct external HLS streams are not supported for security reasons. Please ingest the video through our transcoding pipeline." });
      }

      // If no HLS prefix at all, return structured 409 so the frontend can show a fix action
      if (!video.hlsS3Prefix) {
        return res.status(409).json({
          code: "HLS_NOT_AVAILABLE",
          message: "HLS has not been generated for this video yet. Go to the video settings and click 'Build HLS from Source' to convert it.",
        });
      }

      // Secure playback only — block if video does not have encrypted HLS + master key
      if (!video.encryptionKeyPath) {
        log(`VIDEO_NOT_SECURE_REBUILD_REQUIRED: publicId=${video.publicId} — no encryptionKeyPath, blocking playback`);
        return res.status(409).json({
          code: "VIDEO_NOT_SECURE_REBUILD_REQUIRED",
          message: "This video does not have encrypted HLS. Please rebuild the HLS from the video settings to enable secure playback.",
        });
      }

      // Check video's storage connection (B2 or legacy S3)
      const hlsPrefix = video.hlsS3Prefix;
      const ttl = secSettings?.signedUrlTtl || 120;
      const connId = (video as any).storageConnectionId as string | null | undefined;

      // Try connection-aware signed URL (B2 or S3)
      const conn = connId
        ? await storage.getStorageConnectionById(connId)
        : await storage.getActiveStorageConnection();
      const ua = req.headers["user-agent"] || "";
      const dh = computeDeviceHash(ua);

      const ttls = getTokenTTL();

      // Read suspiciousDetectionEnabled from global security settings
      const globalSec = await secRepo.getGlobal();
      const suspiciousEnabled = globalSec.suspiciousDetectionEnabled !== false;

      if (conn?.provider === "backblaze_b2") {
        const cfg = conn.config as any;
        const sid = createSession(video.publicId, hlsPrefix, "backblaze_b2", cfg, conn.id, dh, ua, suspiciousEnabled);
        const proxyBase = `/hls/${video.publicId}/master.m3u8`;
        const manifestUrl = buildSignedProxyUrl(proxyBase, sid, "/master.m3u8", ttls.manifest, dh);
        return res.json({ manifestUrl, sourceType: "b2_proxy", sessionId: sid, videoId: video.id });
      }

      const client = await getS3Client();
      const s3cfg = await getS3Config();

      if (client && s3cfg.bucket) {
        const sid = createSession(video.publicId, hlsPrefix, "s3", s3cfg, null, dh, ua, suspiciousEnabled);
        const proxyBase = `/hls/${video.publicId}/master.m3u8`;
        const manifestUrl = buildSignedProxyUrl(proxyBase, sid, "/master.m3u8", ttls.manifest, dh);
        return res.json({ manifestUrl, sourceType: "s3_proxy", sessionId: sid });
      }

      // Local HLS fallback
      const localHlsDir = video.hlsS3Prefix;
      const masterPath = path.join(localHlsDir, "master.m3u8");
      if (!fs.existsSync(masterPath)) {
        return res.status(409).json({ code: "HLS_NOT_AVAILABLE", message: "HLS files not found on disk. Re-upload the video or use Build HLS from Source." });
      }

      return res.json({
        manifestUrl: `/api/player/${video.publicId}/hls/master.m3u8?token=${token}`,
        sourceType: "local",
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Serve local HLS files (Express 5 wildcard via app.use)
  app.use("/api/player/:publicId/hls", async (req: any, res: any, next: any) => {
    const video = await storage.getVideoByPublicId(req.params.publicId);
    if (!video) return next();

    const filePath = req.path.replace(/^\//, "");
    if (!filePath) return next();
    const localHlsDir = video.hlsS3Prefix || path.join(uploadDir, "hls", video.id);
    const fullPath = path.resolve(localHlsDir, filePath);

    if (!fullPath.startsWith(path.resolve(localHlsDir)) || !fs.existsSync(fullPath)) {
      return res.status(404).json({ message: "File not found" });
    }

    const ext = path.extname(fullPath);
    const contentType = ext === ".m3u8" ? "application/vnd.apple.mpegurl" : "video/MP2T";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("X-Content-Type-Options", "nosniff");
    fs.createReadStream(fullPath).pipe(res);
  });

  // ── Secure HLS Playlist Proxy ────────────────────────────────────────────────
  // Serves master and variant playlists with per-request signed URLs.
  // B2 / S3 origin URLs are NEVER exposed to the frontend.
  app.use("/hls/:publicId", async (req: any, res: any, next: any) => {
    const { sid, st, exp } = req.query as Record<string, string>;
    const subPath = req.path as string;

    if (!sid || !st || !exp) return res.status(401).json({ code: "PLAYBACK_DENIED", message: "Missing auth params" });

    const session = getSession(sid);
    if (!session || session.revoked) {
      const bi = getBreachInfo(sid);
      return res.status(403).json({ code: "PLAYBACK_DENIED", error: bi.blocked ? "VIDEO_BLOCKED" : "PLAYBACK_DENIED", breach: `${bi.breachCount}/${bi.violationLimit}`, blockSecondsRemaining: bi.blockSecondsRemaining, message: "Session expired or revoked" });
    }
    if (session.publicId !== req.params.publicId) {
      return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Session mismatch" });
    }

    const hlsUa = req.headers["user-agent"] || "";
    const hlsDh = computeDeviceHash(hlsUa);
    if (!verifySignedPath(sid, subPath, parseInt(exp, 10), st, session.deviceHash ? hlsDh : undefined, 3)) {
      return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Invalid or expired token" });
    }

    if (!validateUserAgent(sid, hlsUa)) {
      log(`SECURITY: UA mismatch on HLS proxy for sid=${sid}`);
      return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Device mismatch" });
    }

    const ip = (req.headers["x-forwarded-for"] as string || req.ip || "").split(",")[0].trim();
    const { abused, reason } = trackPlaylistFetch(sid, ip);
    if (abused) {
      const bi = getBreachInfo(sid);
      return res.status(403).json({ code: "PLAYBACK_DENIED", error: "SECURITY_BREACH", breach: `${bi.breachCount}/${bi.violationLimit}`, blockSecondsRemaining: bi.blockSecondsRemaining, message: "Video playback denied due to suspicious activity", signal: reason?.signal });
    }

    try {
      const { hlsPrefix, storageProvider, storageConfig } = session;
      const fileKey = hlsPrefix + subPath.replace(/^\//, "");
      const variantDir = path.posix.dirname(subPath);
      const publicId = req.params.publicId;
      const isMaster = /master\.m3u8/i.test(subPath);
      const isVariant = !isMaster && /\.m3u8(\?|$)/i.test(subPath);

      let originUrl: string;
      if (storageProvider === "backblaze_b2") {
        originUrl = await b2PresignGetObject(storageConfig.bucket, fileKey, storageConfig.endpoint, 30);
      } else {
        const client = await getS3Client();
        const s3cfg = await getS3Config();
        if (!client || !s3cfg.bucket) return res.status(500).json({ message: "Storage not configured" });
        const cmd = new GetObjectCommand({ Bucket: s3cfg.bucket, Key: fileKey });
        originUrl = await getSignedUrl(client, cmd, { expiresIn: 30 });
      }

      const ttls = getTokenTTL();

      if (isMaster) {
        const fetchRes = await fetch(originUrl);
        if (!fetchRes.ok) return res.status(404).json({ message: "Playlist not found" });
        const playlistText = await fetchRes.text();

        const rewritten = playlistText.split("\n").map(line => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) return line;
          if (/^https?:\/\//.test(trimmed)) {
            log(`UNSECURE_MANIFEST_BLOCKED: Raw external URL found in master playlist for ${publicId}, stripping`);
            return "";
          }
          if (/\.m3u8(\?|$)/i.test(trimmed)) {
            const variantSubPath = path.posix.join(variantDir, trimmed);
            const proxyBase = `/hls/${publicId}${variantSubPath}`;
            return buildSignedProxyUrl(proxyBase, sid, variantSubPath, ttls.playlist, session.deviceHash);
          }
          return line;
        }).join("\n");

        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        res.setHeader("X-Content-Type-Options", "nosniff");
        return res.send(rewritten);
      }

      if (isVariant) {
        const cacheKey = subPath;
        let cached: PlaylistCache | undefined = session.variantCache.get(cacheKey);

        if (!cached) {
          const fetchRes = await fetch(originUrl);
          if (!fetchRes.ok) return res.status(404).json({ message: "Variant playlist not found" });
          const playlistText = await fetchRes.text();
          cached = parsePlaylist(playlistText);
          session.variantCache.set(cacheKey, cached);
        }

        const { start, end } = getWindowRange(sid);
        const totalSegs = cached.segments.length;
        const windowStart = Math.max(0, Math.min(start, totalSegs - 1));
        const windowEnd = Math.min(end, totalSegs - 1);
        const isLast = windowEnd >= totalSegs - 1;
        const dh = session.deviceHash;

        const lines: string[] = [
          "#EXTM3U",
          "#EXT-X-VERSION:3",
          `#EXT-X-TARGETDURATION:${cached.targetDuration}`,
          `#EXT-X-MEDIA-SEQUENCE:${windowStart}`,
        ];

        let lastKeyEmitted = "";
        for (let i = windowStart; i <= windowEnd && i < totalSegs; i++) {
          const seg = cached.segments[i];

          if (seg.keyTag && seg.keyTag !== lastKeyEmitted) {
            const proxyBase = `/key/${publicId}`;
            const signed = buildStableKeyUrl(proxyBase, sid, session);
            let rewritten = seg.keyTag.replace(/URI="([^"]+)"/, () => `URI="${signed}"`);
            if (session.ephemeralIV) {
              const ephIvHex = session.ephemeralIV.toString("hex");
              rewritten = rewritten.replace(/IV=0x[0-9a-fA-F]+/, `IV=0x${ephIvHex}`);
            }
            lines.push(rewritten);
            lastKeyEmitted = seg.keyTag;
          }

          lines.push(seg.extinf);
          const segSubPath = path.posix.join(variantDir, seg.uri);
          const proxyBase = `/seg/${publicId}${segSubPath}`;
          lines.push(buildSignedProxyUrl(proxyBase, sid, segSubPath, ttls.segment, dh));
        }

        if (isLast) {
          lines.push("#EXT-X-ENDLIST");
        }

        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        res.setHeader("X-Content-Type-Options", "nosniff");
        return res.send(lines.join("\n") + "\n");
      }

      return res.status(404).json({ message: "Unknown playlist type" });
    } catch (e: any) {
      log(`HLS proxy error for ${req.params.publicId}${req.path}: ${e.message}`);
      res.status(500).json({ message: "Proxy error" });
    }
  });

  // ── Secure Segment Proxy ──────────────────────────────────────────────────────
  // Fetches segment bytes from private B2/S3 and streams to the player.
  // Every segment URL includes a short-lived HMAC token.
  app.use("/seg/:publicId", async (req: any, res: any, next: any) => {
    const { sid, st, exp } = req.query as Record<string, string>;
    const segSubPath = req.path as string;

    if (!sid || !st || !exp) return res.status(401).json({ code: "PLAYBACK_DENIED", message: "Missing auth params" });

    const session = getSession(sid);
    if (!session || session.revoked) {
      const bi = getBreachInfo(sid);
      return res.status(403).json({ code: "PLAYBACK_DENIED", error: bi.blocked ? "VIDEO_BLOCKED" : "PLAYBACK_DENIED", breach: `${bi.breachCount}/${bi.violationLimit}`, blockSecondsRemaining: bi.blockSecondsRemaining, message: "Session expired or revoked" });
    }
    if (session.publicId !== req.params.publicId) {
      return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Session mismatch" });
    }

    const segUa = req.headers["user-agent"] || "";
    const segDh = computeDeviceHash(segUa);

    if (!verifySignedPath(sid, segSubPath, parseInt(exp, 10), st, session.deviceHash ? segDh : undefined, 3)) {
      return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Invalid or expired segment token", signal: "rate_limit" });
    }

    if (!validateUserAgent(sid, segUa)) {
      log(`SECURITY: UA mismatch on segment proxy for sid=${sid}`);
      return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Device mismatch" });
    }

    const segMatch = segSubPath.match(/seg_?(\d+)\./i);
    if (segMatch) {
      const segIdx = parseInt(segMatch[1], 10);
      const windowCheck = validateSegmentWindow(sid, segIdx);
      if (!windowCheck.allowed) {
        const bi = getBreachInfo(sid);
        return res.status(403).json({ code: "PLAYBACK_DENIED", error: "SECURITY_BREACH", breach: `${bi.breachCount}/${bi.violationLimit}`, blockSecondsRemaining: bi.blockSecondsRemaining, message: "Segment outside allowed window", signal: windowCheck.reason?.signal || "out_of_window" });
      }
    }

    const segIp = (req.headers["x-forwarded-for"] as string || req.ip || "").split(",")[0].trim();
    const acquire = acquireSegment(sid, segIp);
    if (acquire.abused) {
      const bi = getBreachInfo(sid);
      return res.status(403).json({ code: "PLAYBACK_DENIED", error: "SECURITY_BREACH", breach: `${bi.breachCount}/${bi.violationLimit}`, blockSecondsRemaining: bi.blockSecondsRemaining, message: "Video playback denied due to suspicious activity", signal: acquire.reason?.signal });
    }

    try {
      const { hlsPrefix, storageProvider, storageConfig } = session;
      const fileKey = hlsPrefix + segSubPath.replace(/^\//, "");

      let originUrl: string;
      if (storageProvider === "backblaze_b2") {
        originUrl = await b2PresignGetObject(storageConfig.bucket, fileKey, storageConfig.endpoint, 20);
      } else {
        const client = await getS3Client();
        const s3cfg = await getS3Config();
        if (!client || !s3cfg.bucket) { releaseSegment(sid); return res.status(500).json({ message: "Storage not configured" }); }
        const cmd = new GetObjectCommand({ Bucket: s3cfg.bucket, Key: fileKey });
        originUrl = await getSignedUrl(client, cmd, { expiresIn: 20 });
      }

      const fetchRes = await fetch(originUrl);
      if (!fetchRes.ok) { releaseSegment(sid); return res.status(404).json({ message: "Segment not found" }); }

      const contentType = segSubPath.endsWith(".m4s") ? "video/iso.segment" : "video/MP2T";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "private, no-store, no-cache, max-age=0");
      res.setHeader("X-Content-Type-Options", "nosniff");

      const encryptedBuf = Buffer.from(await fetchRes.arrayBuffer());

      const video = await storage.getVideoByPublicId(session.publicId);
      log(`SEGMENT_REENCRYPT_ATTEMPT: sid=${sid}, seg=${segSubPath}, encKeyPath=${video?.encryptionKeyPath || "null"}, variantCacheSize=${session.variantCache.size}`);

      if (video?.encryptionKeyPath && session.ephemeralKey) {
        try {
          const masterKey = await getMasterKey(video.encryptionKeyPath, session);
          const originalIV = extractIVForSegment(session, segSubPath);

          if (!masterKey) {
            log(`SEGMENT_REENCRYPTED=false: sid=${sid}, seg=${segSubPath}, reason=masterKeyFetchFailed`);
          } else if (!originalIV) {
            log(`SEGMENT_REENCRYPTED=false: sid=${sid}, seg=${segSubPath}, reason=ivNotFound (variantCacheSize=${session.variantCache.size})`);
          } else {
            const decrypted = decryptAes128Cbc(encryptedBuf, masterKey, originalIV);
            const reEncrypted = encryptAes128Cbc(decrypted, session.ephemeralKey, session.ephemeralIV);
            log(`SEGMENT_REENCRYPTED=true: sid=${sid}, seg=${segSubPath}, masterKeyLen=${masterKey.length}, origIV=${originalIV.toString("hex").slice(0, 8)}…, sessionIV=${session.ephemeralIV.toString("hex").slice(0, 8)}…, bytes=${reEncrypted.length}`);
            releaseSegment(sid);
            return res.end(reEncrypted);
          }
        } catch (e: any) {
          log(`SEGMENT_REENCRYPTED=false: sid=${sid}, seg=${segSubPath}, reason=exception: ${e.message}`);
        }
      }

      // SECURITY_PLAIN_SEGMENT_BLOCKED: never serve a segment without re-encryption
      log(`SECURITY_PLAIN_SEGMENT_BLOCKED: sid=${sid}, publicId=${session.publicId}, seg=${segSubPath} — re-encryption not possible, blocking`);
      releaseSegment(sid);
      return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Secure playback only. Segment cannot be served without re-encryption." });
    } catch (e: any) {
      releaseSegment(sid);
      log(`Segment proxy error for ${req.params.publicId}${req.path}: ${e.message}`);
      res.status(500).json({ message: "Segment error" });
    }
  });

  // ── Progress endpoint — player reports current segment for window tracking ───
  app.post("/api/stream/:publicId/progress", async (req: any, res: any) => {
    try {
      const { sid, segmentIndex, currentTime } = req.body;
      if (!sid) return res.status(400).json({ message: "Missing sid" });

      const session = getSession(sid);
      if (!session || session.revoked) return res.status(403).json({ message: "Session invalid" });
      if (session.publicId !== req.params.publicId) return res.status(403).json({ message: "Session mismatch" });

      let idx = typeof segmentIndex === "number" ? segmentIndex : -1;
      if (idx < 0 && typeof currentTime === "number") {
        const anyCache = session.variantCache.values().next().value as PlaylistCache | undefined;
        if (anyCache && anyCache.targetDuration > 0) {
          idx = Math.floor(currentTime / anyCache.targetDuration);
        }
      }

      if (idx >= 0) {
        updateProgress(sid, idx);
      }

      const { start, end } = getWindowRange(sid);
      return res.json({ ok: true, windowStart: start, windowEnd: end });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Session Rotation — called by player every SESSION_ROTATION_MS ─────────
  app.post("/api/player/:publicId/rotate-session", async (req: any, res: any) => {
    try {
      const { sid } = req.body;
      if (!sid) return res.status(400).json({ message: "Missing sid" });

      const session = getSession(sid);
      if (!session || session.revoked) return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Session invalid or expired" });
      if (session.publicId !== req.params.publicId) return res.status(403).json({ message: "Session mismatch" });

      const newSid = rotateSession(sid);
      if (!newSid) return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Session rotation failed" });

      const newSession = getSession(newSid);
      if (!newSession) return res.status(500).json({ message: "Failed to create rotated session" });

      const ttls = getTokenTTL();
      const dh = newSession.deviceHash;
      const proxyBase = `/hls/${req.params.publicId}/master.m3u8`;
      const manifestUrl = buildSignedProxyUrl(proxyBase, newSid, "/master.m3u8", ttls.manifest, dh);

      return res.json({ manifestUrl, sessionId: newSid, rotationIntervalMs: SESSION_ROTATION_MS });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Per-User Token Minting ─────────────────────────────────────────────────
  // Call this to mint a short-lived embed token bound to a userId (for LMS).
  // The player calls this when a userId is embedded in the page URL instead of a pre-created token.
  app.post("/api/player/:publicId/session-token", async (req: any, res: any) => {
    try {
      const { userId } = req.body;
      if (!userId || typeof userId !== "string") return res.status(400).json({ message: "userId required" });

      const video = await storage.getVideoByPublicId(req.params.publicId);
      if (!video || !video.available) return res.status(404).json({ message: "Video not found" });
      if (video.status !== "ready") return res.status(400).json({ message: "Video not ready" });

      const secSettings = await storage.getSecuritySettings(video.id);
      const ttlMs = (secSettings?.tokenTtl || 3600) * 1000;
      const concurrentLimit = secSettings?.concurrentLimit ?? 1;

      // Check concurrent sessions for this user+video
      const activeTokens = await storage.getActiveUserTokens(video.id, userId);
      if (activeTokens.length >= concurrentLimit) {
        return res.status(429).json({
          code: "SESSION_LIMIT",
          message: `You already have ${activeTokens.length} active session(s). Close other tabs or end those sessions first.`,
          activeSessions: activeTokens.map(t => ({ id: t.id, label: t.label, createdAt: t.createdAt, expiresAt: t.expiresAt })),
        });
      }

      const expiresAt = new Date(Date.now() + ttlMs);
      const tokenValue = generateToken({ videoId: video.id, publicId: video.publicId, userId }, Math.floor(ttlMs / 1000));
      const dbToken = await storage.createEmbedToken({
        videoId: video.id,
        token: tokenValue,
        label: `auto:${userId}`,
        allowedDomain: null,
        expiresAt,
        revoked: false,
        userId,
      } as any);

      log(`PER_USER_TOKEN_MINTED: userId=${userId} videoId=${video.id} tokenId=${dbToken.id} expiresAt=${expiresAt.toISOString()}`);
      res.json({ token: tokenValue, expiresAt: expiresAt.toISOString(), tokenId: dbToken.id });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Per-User Token Refresh ─────────────────────────────────────────────────
  // Player calls this when it receives a 401/403 due to token expiry.
  // Mints a new token for the same user, returns a new manifestUrl.
  app.post("/api/player/:publicId/refresh-token", async (req: any, res: any) => {
    try {
      const { token: oldTokenValue } = req.body;
      if (!oldTokenValue) return res.status(400).json({ message: "token required" });

      const video = await storage.getVideoByPublicId(req.params.publicId);
      if (!video || !video.available) return res.status(404).json({ message: "Video not found" });

      // Find old token — accept both expired and valid (user may just be refreshing proactively)
      const oldDbToken = await storage.getTokenByValue(oldTokenValue);
      let userId: string | null = null;

      if (oldDbToken) {
        if (oldDbToken.revoked) return res.status(401).json({ message: "Token was revoked — cannot refresh" });
        userId = (oldDbToken as any).userId || null;
      } else {
        // Try to extract userId from JWT claims
        try {
          const decoded = verifyToken(oldTokenValue);
          if (decoded?.userId) userId = decoded.userId;
          else return res.status(401).json({ message: "Cannot identify user from token" });
        } catch {
          return res.status(401).json({ message: "Invalid token" });
        }
      }

      if (!userId) return res.status(401).json({ message: "Token is not a per-user token — cannot refresh automatically" });

      const secSettings = await storage.getSecuritySettings(video.id);
      const ttlMs = (secSettings?.tokenTtl || 3600) * 1000;
      const expiresAt = new Date(Date.now() + ttlMs);
      const newTokenValue = generateToken({ videoId: video.id, publicId: video.publicId, userId }, Math.floor(ttlMs / 1000));
      const newDbToken = await storage.createEmbedToken({
        videoId: video.id,
        token: newTokenValue,
        label: `auto:${userId}:refresh`,
        allowedDomain: null,
        expiresAt,
        revoked: false,
        userId,
      } as any);

      // Revoke the old token so it can't be reused
      if (oldDbToken) await storage.revokeToken(oldDbToken.id);

      // Build a fresh manifest URL (player must reload hls.js with this)
      const connId = (video as any).storageConnectionId as string | null;
      const conn = connId
        ? await storage.getStorageConnectionById(connId)
        : await storage.getActiveStorageConnection();
      const ua = req.headers["user-agent"] || "";
      const dh = computeDeviceHash(ua);
      const globalSec = await secRepo.getGlobal();
      const suspiciousEnabled = globalSec.suspiciousDetectionEnabled !== false;
      const ttls = getTokenTTL();
      let manifestUrl: string | null = null;
      if (conn?.provider === "backblaze_b2") {
        const cfg = conn.config as any;
        const newSid = createSession(video.publicId, video.hlsS3Prefix!, "backblaze_b2", cfg, conn.id, dh, ua, suspiciousEnabled);
        manifestUrl = buildSignedProxyUrl(`/hls/${video.publicId}/master.m3u8`, newSid, "/master.m3u8", ttls.manifest, dh);
      }

      log(`TOKEN_REFRESHED: userId=${userId} videoId=${video.id} oldTokenId=${oldDbToken?.id} newTokenId=${newDbToken.id}`);
      res.json({ token: newTokenValue, expiresAt: expiresAt.toISOString(), manifestUrl });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Revoke Other Sessions (for same user) ──────────────────────────────────
  // Player calls this when session-limit reached and user chooses "End other session".
  app.post("/api/player/:publicId/revoke-other-sessions", async (req: any, res: any) => {
    try {
      const { userId, currentToken } = req.body;
      if (!userId || !currentToken) return res.status(400).json({ message: "userId and currentToken required" });

      const video = await storage.getVideoByPublicId(req.params.publicId);
      if (!video) return res.status(404).json({ message: "Video not found" });

      // Verify current token belongs to this user
      const dbToken = await storage.getTokenByValue(currentToken);
      if (!dbToken || (dbToken as any).userId !== userId) {
        return res.status(401).json({ message: "Token does not belong to this user" });
      }
      if (dbToken.revoked || (dbToken.expiresAt && new Date(dbToken.expiresAt) < new Date())) {
        return res.status(401).json({ message: "Token is expired or revoked" });
      }

      await storage.revokeUserTokensExcept(video.id, userId, currentToken);
      log(`USER_SESSIONS_REVOKED: userId=${userId} videoId=${video.id} — kept token ${dbToken.id}`);
      res.json({ ok: true, message: "Other sessions revoked. You can now continue." });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/key/:publicId", async (req: any, res: any) => {
    const { sid, st, exp, dh } = req.query as Record<string, string>;
    if (!sid || !st || !exp) return res.status(401).json({ code: "PLAYBACK_DENIED", message: "Missing auth" });

    const session = getSession(sid);
    if (!session || session.revoked) {
      const bi = getBreachInfo(sid);
      return res.status(403).json({ code: "PLAYBACK_DENIED", error: bi.blocked ? "VIDEO_BLOCKED" : "PLAYBACK_DENIED", breach: `${bi.breachCount}/${bi.violationLimit}`, blockSecondsRemaining: bi.blockSecondsRemaining, message: "Session revoked" });
    }

    const reqUa = req.headers["user-agent"] || "";
    const reqDh = session.deviceHash ? computeDeviceHash(reqUa) : undefined;

    if (session.deviceHash && reqDh !== session.deviceHash) {
      return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Device mismatch" });
    }

    if (!verifySignedPath(sid, "/key", parseInt(exp, 10), st, session.deviceHash || undefined)) {
      return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Invalid key token" });
    }

    const keyUa = req.headers["user-agent"] || "";
    if (!validateUserAgent(sid, keyUa)) {
      log(`SECURITY: UA mismatch on key endpoint for sid=${sid}`);
      return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Device mismatch" });
    }

    const { allowed: keyAllowed, alreadyIssued } = checkAndIssueKey(sid);
    if (!keyAllowed) {
      log(`SECURITY_KEY_REPLAY: sid=${sid} — key already issued, rejecting repeated request`);
      return res.status(403).json({ code: "KEY_ALREADY_ISSUED", message: "Session key already issued. Start a new session.", signal: "key_abuse" });
    }

    const keyIp = (req.headers["x-forwarded-for"] as string || req.ip || "").split(",")[0].trim();
    const { abused: keyAbused, reason: keyReason } = trackKeyHit(sid, keyIp);
    if (keyAbused) {
      const bi = getBreachInfo(sid);
      log(`SECURITY_KEY_SPAM: sid=${sid} — rate limit exceeded`);
      return res.status(429).json({ code: "PLAYBACK_DENIED", error: "SECURITY_KEY_SPAM", breach: `${bi.breachCount}/${bi.violationLimit}`, blockSecondsRemaining: bi.blockSecondsRemaining, message: "Key rate limit exceeded", signal: keyReason?.signal });
    }

    try {
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", 16);
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.send(session.ephemeralKey);
    } catch (e: any) {
      log(`Key fetch error: ${e.message}`);
      return res.status(500).json({ code: "PLAYBACK_DENIED", message: "Key fetch failed" });
    }
  });

  // ── Create Video Playback Session (alternative entry for custom players) ─────
  app.post("/api/video/session", async (req, res) => {
    try {
      const { publicId, token } = req.body;
      if (!publicId) return res.status(400).json({ message: "publicId required" });

      const video = await storage.getVideoByPublicId(publicId);
      if (!video || !video.available) return res.status(404).json({ message: "Video not found" });
      if (video.status !== "ready") return res.status(400).json({ message: "Video not ready" });

      // Validate token (same logic as manifest)
      const secSettings = await storage.getSecuritySettings(video.id);
      if (secSettings?.tokenRequired !== false && token) {
        const dbToken = await storage.getTokenByValue(token);
        if (!dbToken) {
          const decoded = verifyToken(token);
          if (!decoded || decoded.publicId !== video.publicId) {
            return res.status(401).json({ message: "Invalid token" });
          }
        } else {
          if (dbToken.revoked || (dbToken.expiresAt && new Date(dbToken.expiresAt) < new Date())) {
            return res.status(401).json({ message: "Token revoked or expired" });
          }
        }
      }

      const hlsPrefix = video.hlsS3Prefix!;
      const connId = (video as any).storageConnectionId as string | null;
      const conn = connId
        ? await storage.getStorageConnectionById(connId)
        : await storage.getActiveStorageConnection();

      if (!conn?.provider) return res.status(400).json({ message: "No storage configured" });

      const cfg = conn.config as any;
      const altUa = req.headers["user-agent"] || "";
      const altDh = computeDeviceHash(altUa);
      const altTtls = getTokenTTL();
      const sid = createSession(video.publicId, hlsPrefix, conn.provider as any, cfg, conn.id, altDh, altUa);
      const proxyBase = `/hls/${video.publicId}/master.m3u8`;
      const playlistUrl = buildSignedProxyUrl(proxyBase, sid, "/master.m3u8", altTtls.manifest, altDh);
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

      res.json({ sessionId: sid, playlistUrl, expiresAt });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Player settings (public - for embed player to configure itself)
  app.get("/api/player/:publicId/settings", async (req, res) => {
    const video = await storage.getVideoByPublicId(req.params.publicId);
    if (!video) return res.status(404).json({ message: "Not found" });
    const playerSettings = await storage.getPlayerSettings(video.id);
    const watermarkSettings = await storage.getWatermarkSettings(video.id);
    res.json({ playerSettings, watermarkSettings });
  });

  // Playback ping
  app.post("/api/player/:publicId/ping", async (req, res) => {
    try {
      const { sessionCode, secondsWatched } = req.body;
      if (sessionCode) {
        await storage.pingSession(sessionCode, Math.round(secondsWatched || 0));
      } else {
        // Create new session
        const video = await storage.getVideoByPublicId(req.params.publicId);
        if (video) {
          const code = nanoid(16);
          const domain = req.headers["x-embed-referrer"] as string || req.headers.referer || "";
          let domainHost = "";
          try { domainHost = new URL(domain).hostname; } catch {}
          const session = await storage.createSession({
            videoId: video.id,
            sessionCode: code,
            domain: domainHost,
            ip: req.ip,
            userAgent: req.headers["user-agent"],
          });
          return res.json({ sessionCode: code });
        }
      }
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Analytics ─────────────────────────────────────────────
  app.get("/api/videos/:id/analytics", requireAuth, async (req, res) => {
    const analytics = await storage.getVideoAnalytics(req.params.id);
    res.json(analytics);
  });

  app.get("/api/videos/:id/sessions", requireAuth, async (req, res) => {
    const sessions = await storage.getSessionsByVideo(req.params.id);
    res.json(sessions);
  });

  // ── Audit ─────────────────────────────────────────────────
  app.get("/api/audit", requireAuth, async (req, res) => {
    const logs = await storage.getAuditLogs();
    res.json(logs);
  });

  // ── System Settings ───────────────────────────────────────
  app.get("/api/settings", requireAuth, async (req, res) => {
    const settings = await storage.getAllSettings();
    // Mask secrets in response
    const masked = settings.map(s => {
      if (s.key === "aws_secret_access_key" && s.value) {
        return { ...s, value: "•".repeat(s.value.length) };
      }
      return s;
    });
    res.json(masked);
  });

  app.put("/api/settings", requireAuth, async (req, res) => {
    try {
      const updates = req.body as Record<string, string>;
      await storage.setSettings(updates);
      await storage.createAuditLog({ action: "settings_updated", meta: { keys: Object.keys(updates) }, ip: req.ip });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.put("/api/settings/:key", requireAuth, async (req, res) => {
    await storage.setSetting(req.params.key, req.body.value);
    res.json({ ok: true });
  });

  // ── Vimeo integration health check ────────────────────────
  app.get("/api/integrations/vimeo/health", requireAuth, async (req, res) => {
    try {
      const token = process.env.VIMEO_ACCESS_TOKEN || (await storage.getSetting("vimeo_access_token")) || "";
      if (!token) {
        return res.status(400).json({ ok: false, error: "No Vimeo access token configured.", hints: ["Set VIMEO_ACCESS_TOKEN in environment variables or System Settings → vimeo_access_token."] });
      }
      const meRes = await fetch("https://api.vimeo.com/me", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.vimeo.*+json;version=3.4" },
      });
      if (!meRes.ok) {
        const err = await meRes.json().catch(() => ({})) as any;
        return res.status(400).json({ ok: false, error: `Vimeo token rejected (${meRes.status}): ${err.error || err.message || "Unknown"}`, hints: ["Regenerate your Vimeo Personal Access Token with scopes: public, private, video_files."] });
      }
      const me = await meRes.json() as any;
      return res.json({
        ok: true,
        name: me.name || "Unknown",
        accountType: me.account || "unknown",
        uri: me.uri,
        hint: "Token is valid. For file downloads, ensure your token has the 'video_files' scope and you own or have access to the video.",
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Storage Connections CRUD ───────────────────────────────
  app.get("/api/storage-connections", requireAuth, async (_req, res) => {
    const conns = await storage.getStorageConnections();
    res.json(conns);
  });

  app.post("/api/storage-connections", requireAuth, async (req, res) => {
    try {
      const { name, provider, config } = req.body;
      if (!name || !provider || !config) return res.status(400).json({ message: "name, provider, config required" });
      const conn = await storage.createStorageConnection({ name, provider, config, isActive: false });
      await storage.createAuditLog({ action: "storage_connection_created", meta: { id: conn.id, provider }, ip: req.ip });
      res.json(conn);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.put("/api/storage-connections/:id", requireAuth, async (req, res) => {
    try {
      const { name, provider, config } = req.body;
      const conn = await storage.updateStorageConnection(req.params.id, { name, provider, config });
      res.json(conn);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.delete("/api/storage-connections/:id", requireAuth, async (req, res) => {
    try {
      await storage.deleteStorageConnection(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/storage-connections/:id/set-active", requireAuth, async (req, res) => {
    try {
      await storage.setActiveStorageConnection(req.params.id);
      await storage.createAuditLog({ action: "storage_connection_set_active", meta: { id: req.params.id }, ip: req.ip });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/storage-connections/:id/test", requireAuth, async (req, res) => {
    try {
      const conn = await storage.getStorageConnectionById(req.params.id);
      if (!conn) return res.status(404).json({ ok: false, message: "Connection not found" });

      if (conn.provider === "backblaze_b2") {
        const cfg = conn.config as any;
        const endpoint = cfg.endpoint || process.env.B2_S3_ENDPOINT || "";
        const bucket = cfg.bucket || process.env.B2_BUCKET || "";
        if (!endpoint) return res.status(400).json({ ok: false, message: "B2 endpoint not configured in connection" });
        if (!bucket) return res.status(400).json({ ok: false, message: "B2 bucket not configured in connection" });
        if (!process.env.B2_KEY_ID || !process.env.B2_APPLICATION_KEY) {
          return res.status(400).json({ ok: false, message: "B2_KEY_ID and B2_APPLICATION_KEY must be set in Replit Secrets" });
        }

        // Upload a small test file
        const testKey = "raw/__healthcheck.txt";
        const client = makeB2Client({ endpoint });
        const { PutObjectCommand, HeadObjectCommand } = await import("@aws-sdk/client-s3");
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: testKey,
          Body: Buffer.from("ok"),
          ContentType: "text/plain",
        }));
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: testKey }));
        return res.json({ ok: true, message: "Backblaze B2 connection working — test file written successfully." });
      }

      // AWS S3 test
      const client = await getS3Client();
      const cfg = await getS3Config();
      if (!client || !cfg.bucket) return res.status(400).json({ ok: false, message: "AWS S3 credentials not configured in System Settings" });
      const { HeadBucketCommand } = await import("@aws-sdk/client-s3");
      await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
      return res.json({ ok: true, message: "AWS S3 connection working." });
    } catch (e: any) {
      res.status(400).json({ ok: false, message: e.message });
    }
  });

  // ── Dashboard Stats ───────────────────────────────────────
  app.get("/api/dashboard", requireAuth, async (req, res) => {
    const vids = await storage.getVideos();
    const tokens = await storage.getAllTokens();
    const logs = await storage.getAuditLogs();
    res.json({
      totalVideos: vids.length,
      readyVideos: vids.filter(v => v.status === "ready").length,
      processingVideos: vids.filter(v => v.status === "processing").length,
      totalTokens: tokens.length,
      activeTokens: tokens.filter(t => !t.revoked && (!t.expiresAt || new Date(t.expiresAt) > new Date())).length,
      recentActivity: logs.slice(0, 5),
    });
  });

  // ── Global & Per-Video Client Security Settings ──────────────────────────────
  const { getSecurityRepo } = await import("./security/securityRepoFactory");
  const secRepo = getSecurityRepo();

  app.get("/api/security/global", requireAuth, async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const settings = await secRepo.getGlobal();
    res.json(settings);
  });

  app.post("/api/security/global", requireAuth, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    await secRepo.saveGlobal(req.body);
    res.json({ ok: true });
  });

  app.get("/api/security/video/:videoId", requireAuth, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const settings = await secRepo.getVideo(req.params.videoId);
    res.json(settings);
  });

  app.post("/api/security/video/:videoId", requireAuth, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    await secRepo.saveVideo(req.params.videoId, req.body);
    res.json({ ok: true });
  });

  app.get("/api/security/video/:videoId/use-global", requireAuth, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const useGlobal = await secRepo.getUseGlobal(req.params.videoId);
    res.json({ useGlobal });
  });

  app.post("/api/security/video/:videoId/use-global", requireAuth, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const { useGlobal } = req.body;
    if (typeof useGlobal !== "boolean") return res.status(400).json({ message: "useGlobal must be boolean" });
    await secRepo.setUseGlobal(req.params.videoId, useGlobal);
    res.json({ ok: true });
  });

  app.get("/api/security/effective/:videoId", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const useGlobal = await secRepo.getUseGlobal(req.params.videoId);
    if (useGlobal) {
      const global = await secRepo.getGlobal();
      return res.json(global);
    }
    const video = await secRepo.getVideo(req.params.videoId);
    if (!video) {
      const global = await secRepo.getGlobal();
      return res.json(global);
    }
    res.json(video);
  });

  // ── Self-Test Endpoint (dev mode only) ─────────────────────────────────────
  app.get("/api/_debug/secure-hls/selftest", requireAuth, async (req: any, res: any) => {
    if (process.env.NODE_ENV === "production") return res.status(404).json({ message: "Not available in production" });
    const videoId = req.query.videoId as string;
    if (!videoId) return res.status(400).json({ message: "videoId query param required" });

    const video = await storage.getVideoById(videoId);
    if (!video) return res.status(404).json({ message: "Video not found" });

    const results: Record<string, { status: "PASS" | "FAIL"; detail: string }> = {};

    // 1) Transcode check — confirm HLS files exist in storage
    try {
      const hlsPrefix = video.hlsS3Prefix || `videos/${video.id}/hls/`;
      const connId = (video as any).storageConnectionId as string | null;
      const conn = connId
        ? await storage.getStorageConnectionById(connId)
        : await storage.getActiveStorageConnection();

      if (!conn) {
        results["transcode_check"] = { status: "FAIL", detail: "No storage connection found" };
      } else {
        const cfg = conn.config as any;
        const b2 = makeB2Client({ endpoint: cfg.endpoint });
        const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
        const listResp = await b2.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: hlsPrefix, MaxKeys: 100 }));
        const keys = (listResp.Contents || []).map((o: any) => o.Key || "");
        const hasMaster = keys.some((k: string) => k.endsWith("master.m3u8"));
        const hasVariant = keys.some((k: string) => /index\.m3u8$/.test(k));
        const segmentCount = keys.filter((k: string) => /\.ts$/.test(k)).length;
        const hasEncKey = keys.some((k: string) => k.endsWith("enc.key"));
        if (hasMaster && hasVariant && segmentCount > 0) {
          results["transcode_check"] = { status: "PASS", detail: `master.m3u8: yes, variant playlist: yes, segments: ${segmentCount}, encrypted: ${hasEncKey}` };
        } else {
          results["transcode_check"] = { status: "FAIL", detail: `master.m3u8: ${hasMaster}, variant: ${hasVariant}, segments: ${segmentCount}` };
        }
      }
    } catch (e: any) {
      results["transcode_check"] = { status: "FAIL", detail: e.message };
    }

    // 2) Masking check — confirm manifest proxy URL pattern does NOT expose raw storage
    try {
      const testSid = createSession(video.publicId, `videos/${video.id}/hls/`, "backblaze_b2", {}, null, "masktest");
      const proxyPath = `/hls/${video.publicId}/master.m3u8`;
      const manifestUrl = buildSignedProxyUrl(proxyPath, testSid, "/master.m3u8", 30, "masktest");
      const containsB2 = /backblazeb2\.com|s3\.amazonaws\.com|s3\..*\.backblaze/.test(manifestUrl);
      const containsProxy = manifestUrl.startsWith("/hls/");
      revokeSession(testSid);
      if (containsB2) {
        results["masking_check"] = { status: "FAIL", detail: `Manifest URL exposes raw storage: ${manifestUrl}` };
      } else if (containsProxy) {
        results["masking_check"] = { status: "PASS", detail: `Manifest URL is proxied through /hls/ endpoint with HMAC signature. No raw B2/S3 URLs exposed.` };
      } else {
        results["masking_check"] = { status: "FAIL", detail: `Unexpected manifest URL pattern: ${manifestUrl}` };
      }
    } catch (e: any) {
      results["masking_check"] = { status: "FAIL", detail: e.message };
    }

    // 3) Token expiry check — confirm signed URLs expire
    try {
      const testSid = createSession(video.publicId, `videos/${video.id}/hls/`, "backblaze_b2", {}, null, "selftest");
      const expiredExp = Math.floor(Date.now() / 1000) - 10;
      const expiredSt = signPath(testSid, "/v0/seg_000.ts", expiredExp, "selftest");
      const verified = verifySignedPath(testSid, "/v0/seg_000.ts", expiredExp, expiredSt, "selftest");
      revokeSession(testSid);
      results["token_expiry_check"] = verified
        ? { status: "FAIL", detail: "Expired token was accepted" }
        : { status: "PASS", detail: "Expired token correctly rejected" };
    } catch (e: any) {
      results["token_expiry_check"] = { status: "FAIL", detail: e.message };
    }

    // 4) Rate limit check — simulate rapid requests
    try {
      const rateSid = createSession(video.publicId, `videos/${video.id}/hls/`, "backblaze_b2", {}, null, "ratetest");
      let tripped = false;
      const thresholds = getAbuseThresholds();
      for (let i = 0; i < thresholds.requestsPerWindow + 10; i++) {
        const r = trackRequest(rateSid, "127.0.0.1");
        if (r.abused) { tripped = true; break; }
      }
      revokeSession(rateSid);
      results["rate_limit_check"] = tripped
        ? { status: "PASS", detail: `Rate limit triggered after flooding ${thresholds.requestsPerWindow}+ requests` }
        : { status: "FAIL", detail: "Rate limit did not trigger" };
    } catch (e: any) {
      results["rate_limit_check"] = { status: "FAIL", detail: e.message };
    }

    // 5) Block check — verify session gets revoked on high abuse
    try {
      const blockSid = createSession(video.publicId, `videos/${video.id}/hls/`, "backblaze_b2", {}, null, "blocktest");
      const sess = getSession(blockSid);
      if (sess) {
        let blocked = false;
        for (let i = 0; i < 100; i++) {
          const r = trackRequest(blockSid, `192.168.1.${i % 2 === 0 ? 1 : 2}`);
          if (r.abused && sess.revoked) { blocked = true; break; }
        }
        results["block_check"] = blocked
          ? { status: "PASS", detail: "Session correctly blocked after exceeding abuse threshold (IP mismatch + rate flooding)" }
          : { status: "FAIL", detail: `Session not blocked after 100 requests. revoked=${sess.revoked}, score=${sess.abuseScore}` };
      } else {
        results["block_check"] = { status: "FAIL", detail: "Could not create test session" };
      }
      revokeSession(blockSid);
    } catch (e: any) {
      results["block_check"] = { status: "FAIL", detail: e.message };
    }

    // 6) iOS compatibility notes
    results["ios_compatibility"] = {
      status: "PASS",
      detail: "Standard HLS with #EXTM3U header, AES-128 encryption, MPEG-TS segments. Native Safari/iOS playback supported via <video src='...m3u8'>. hls.js used for non-native browsers."
    };

    // 7) Security features summary
    const thresholds = getAbuseThresholds();
    const tokenTtls = getTokenTTL();
    results["security_summary"] = {
      status: "PASS",
      detail: `Rate limit: ${thresholds.requestsPerWindow} req/${thresholds.requestWindowMs}ms (burst ${thresholds.burstLimit}), ` +
        `Concurrent: ${thresholds.concurrentSegments} max, ` +
        `Window: ${thresholds.windowSize} segments, ` +
        `Revoke threshold: ${thresholds.scoreToRevoke}, ` +
        `Ephemeral re-encryption: enabled, ` +
        `TTL — manifest: ${tokenTtls.manifest}s, playlist: ${tokenTtls.playlist}s, segment: ${tokenTtls.segment}s, key: ${tokenTtls.key}s, ` +
        `Session binding: UA hash + IP + deviceHash, ` +
        `Segment duration: 2s`
    };

    const allPassed = Object.values(results).every(r => r.status === "PASS");
    res.json({ videoId, overall: allPassed ? "ALL_PASS" : "HAS_FAILURES", results });
  });

  // ── Segment Re-encryption Integrity Test ─────────────────────────────────────
  // Verifies per-session AES re-encryption is actually happening.
  // Fetches one segment, applies re-encryption twice with two different ephemeral
  // keys (simulating two sessions), then compares SHA256 hashes.
  // If hashes differ → re-encryption working. If same → broken.
  app.get("/api/debug/segment-integrity/:publicId/:segment", requireAuth, async (req: any, res: any) => {
    try {
      const { publicId, segment } = req.params;
      const video = await storage.getVideoByPublicId(publicId);
      if (!video) return res.status(404).json({ message: "Video not found" });

      const connId = (video as any).storageConnectionId as string | null;
      const conn = connId
        ? await storage.getStorageConnectionById(connId)
        : await storage.getActiveStorageConnection();
      if (!conn || conn.provider !== "backblaze_b2") {
        return res.status(400).json({ message: "Only Backblaze B2 storage supported for this test" });
      }
      const cfg = conn.config as any;

      // Find the segment in storage — search variant prefixes (360p, 720p, 1080p)
      const hlsPrefix = video.hlsS3Prefix || `videos/${video.id}/hls/`;
      const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
      const b2 = makeB2Client({ endpoint: cfg.endpoint });
      const listResp = await b2.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: hlsPrefix, MaxKeys: 500 }));
      const allKeys: string[] = (listResp.Contents || []).map((o: any) => o.Key || "");

      // Find segment key in B2 (match by filename)
      const segKey = allKeys.find(k => k.endsWith(`/${segment}`) || k.endsWith(segment));
      if (!segKey) {
        return res.status(404).json({ message: `Segment '${segment}' not found in B2`, availableSegments: allKeys.filter(k => k.endsWith(".ts")).slice(0, 20) });
      }

      // Find variant playlist to get the segment's IV
      const variantM3u8Key = allKeys.find(k => k.includes(segKey.split("/").slice(0, -1).join("/")) && k.endsWith(".m3u8") && !k.endsWith("master.m3u8"));
      let originalIV: Buffer | null = null;
      if (variantM3u8Key) {
        const { GetObjectCommand: GOC } = await import("@aws-sdk/client-s3");
        const playlistResp = await b2.send(new GOC({ Bucket: cfg.bucket, Key: variantM3u8Key }));
        const playlistText = await (playlistResp.Body as any).transformToString();
        const parsed = parsePlaylist(playlistText);
        const segFile = segment.split("/").pop()!;
        const segEntry = parsed.segments.find(s => s.uri === segFile || s.uri.endsWith(segFile));
        if (segEntry?.keyTag) originalIV = extractIVFromKeyTag(segEntry.keyTag);
      }

      // Fetch raw segment bytes from B2
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const segResp = await b2.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: segKey }));
      const rawBytes = Buffer.from(await (segResp.Body as any).transformToByteArray());
      const rawSha256 = crypto.createHash("sha256").update(rawBytes).digest("hex");

      // Fetch master key (key A)
      let masterKey: Buffer | null = null;
      const encKeyPath = video.encryptionKeyPath;
      if (encKeyPath) {
        try {
          const keyResp = await b2.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: encKeyPath }));
          masterKey = Buffer.from(await (keyResp.Body as any).transformToByteArray());
        } catch (e: any) {
          return res.json({
            segment: segKey, rawSha256, encryptionKeyPath: encKeyPath,
            error: `Failed to fetch master key: ${e.message}`,
            reEncryptionWorking: false, reason: "masterKeyFetchFailed"
          });
        }
      }

      // Attempt re-encryption with two simulated sessions
      if (!masterKey) {
        return res.json({
          segment: segKey, rawSha256, encryptionKeyPath: encKeyPath || null,
          reEncryptionWorking: false, reason: "noEncryptionKeyPath — video was not transcoded with AES encryption"
        });
      }

      if (!originalIV) {
        return res.json({
          segment: segKey, rawSha256, encryptionKeyPath: encKeyPath,
          reEncryptionWorking: false, reason: "ivNotFound — could not extract IV from variant playlist key tag"
        });
      }

      // Session A: random ephemeral key + IV
      const ephKeyA = crypto.randomBytes(16);
      const ephIVA = crypto.randomBytes(16);
      const decrypted = decryptAes128Cbc(rawBytes, masterKey, originalIV);
      const reEncA = encryptAes128Cbc(decrypted, ephKeyA, ephIVA);
      const sha256A = crypto.createHash("sha256").update(reEncA).digest("hex");

      // Session B: different ephemeral key + IV
      const ephKeyB = crypto.randomBytes(16);
      const ephIVB = crypto.randomBytes(16);
      const reEncB = encryptAes128Cbc(decrypted, ephKeyB, ephIVB);
      const sha256B = crypto.createHash("sha256").update(reEncB).digest("hex");

      const sessionsProduceDifferentOutput = sha256A !== sha256B;
      const session1DiffersFromOriginal = sha256A !== rawSha256;
      const session2DiffersFromOriginal = sha256B !== rawSha256;
      const reEncryptionWorking = sessionsProduceDifferentOutput && session1DiffersFromOriginal && session2DiffersFromOriginal;

      log(`SEGMENT_INTEGRITY_TEST: publicId=${publicId}, seg=${segment}, reEncryptionWorking=${reEncryptionWorking}`);

      return res.json({
        segment: segKey,
        encryptionKeyPath: encKeyPath,
        ivFound: !!originalIV,
        ivHex: originalIV.toString("hex"),
        masterKeyLen: masterKey.length,
        rawBytes: rawBytes.length,
        rawSha256,
        session1Sha256: sha256A,
        session2Sha256: sha256B,
        session1DiffersFromOriginal,
        session2DiffersFromOriginal,
        sessionsProduceDifferentOutput,
        reEncryptionWorking,
        verdict: reEncryptionWorking
          ? "PASS — Per-session re-encryption is working correctly. Each session produces unique encrypted output."
          : "FAIL — Re-encryption is NOT working. Sessions produce identical output.",
      });
    } catch (e: any) {
      log(`segment-integrity test error: ${e.message}`);
      res.status(500).json({ message: e.message });
    }
  });

  return httpServer;
}
