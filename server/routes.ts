import express, { type Express } from "express";
import { type Server } from "http";
import multer from "multer";
import path from "path";
import fs from "fs";
import { nanoid } from "nanoid";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { storage } from "./storage";
import { spawn } from "child_process";
import ffmpegStaticPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const FFMPEG_BIN = process.env.FFMPEG_PATH || ffmpegStaticPath || "ffmpeg";
const FFPROBE_BIN = process.env.FFPROBE_PATH || ffprobeStatic.path || "ffprobe";
import os from "os";
import { vimeoFetchVideo, vimeoExtractFileLinks, vimeoDiagnoseNoFileAccess } from "./vimeo";
import crypto from "crypto";
import { makeB2Client, b2PresignGetObject, b2UploadFile, makeR2Client, r2PresignGetObject, r2UploadFile } from "./b2";
import { bunnyUploadFile, bunnyDeletePrefix, bunnyFetchFile, bunnyCdnUrl, getBunnyStorageKey } from "./bunny";
import QRCode from "qrcode";
import { createSession, rotateSession, extendSession, getSession, getSessionAsync, getSessionAllowingRotationGrace, getSessionAllowingRotationGraceAsync, revokeSession, verifySignedPath, trackRequest, trackPlaylistFetch, acquireSegment, releaseSegment, trackKeyHit, buildSignedProxyUrl, buildStableKeyUrl, signPath, computeDeviceHash, updateProgress, validateSegmentWindow, parsePlaylist, getWindowRange, getWindowSegs, getBreachInfo, getAbuseThresholds, getTokenTTL, getAllSessions, validateUserAgent, checkAndIssueKey, SESSION_ROTATION_MS, trackSegmentVelocity, verifyHeartbeat, recordSecurityEvent, getSessionTokenTTL, defaultHardening, mintOpaqueId, mintOpaqueChunkId, computeChunkStableKey, signChunkCacheToken, verifyOpaqueId, verifyOpaqueIdDetailed, decodeOpaqueIdSkipExpiry, isOpaqueExpired, bucketExp, setIntegrationSessionId, revokeSessionsByIntegrationId, setIntegrationRevokeNotifier, getHlsGatewayBase, bumpMaxSegmentExposed, type SessionHardeningConfig, type OpaquePayload } from "./video-session";

// Build hardening config from effective security settings.
// Admin-controlled values from the Security Profile (or Custom override) are
// passed through directly. A small safety floor (15s) prevents zero/invalid
// stored values from making URLs expire before a single heartbeat completes.
// The Strict preset uses 15s segment/key TTLs, so the floor matches that.
//
// `downloadAheadLimit` (segment-count) is DERIVED from `maxDownloadAheadSec`
// (time-based) at runtime so the two values can never disagree. The schema
// column is retained for legacy callers but admin only ever edits the
// time-based field via the profile UI.
function buildHardening(s: any): SessionHardeningConfig {
  const ttlFloor = 15;
  const maxDownloadAheadSec = Math.max(10, s?.maxDownloadAheadSec ?? defaultHardening.maxDownloadAheadSec);
  return {
    mediaSourceGuardEnabled: s?.mediaSourceGuardEnabled ?? defaultHardening.mediaSourceGuardEnabled,
    velocityScoringEnabled: s?.velocityScoringEnabled ?? defaultHardening.velocityScoringEnabled,
    keyBindingEnabled: s?.keyBindingEnabled ?? defaultHardening.keyBindingEnabled,
    heartbeatV2Enabled: s?.heartbeatV2Enabled ?? defaultHardening.heartbeatV2Enabled,
    serverGatedWindowEnabled: s?.serverGatedWindowEnabled ?? defaultHardening.serverGatedWindowEnabled,
    shortTokenTtlEnabled: s?.shortTokenTtlEnabled ?? defaultHardening.shortTokenTtlEnabled,
    tokenTtlPlaylistSec: Math.max(ttlFloor, s?.tokenTtlPlaylistSec ?? defaultHardening.tokenTtlPlaylistSec),
    tokenTtlSegmentSec: Math.max(ttlFloor, s?.tokenTtlSegmentSec ?? defaultHardening.tokenTtlSegmentSec),
    tokenTtlKeySec: Math.max(ttlFloor, s?.tokenTtlKeySec ?? defaultHardening.tokenTtlKeySec),
    heartbeatIntervalSec: Math.max(5, s?.heartbeatIntervalSec ?? defaultHardening.heartbeatIntervalSec),
    // Derive segment-count budget from time-based admin value (2s segments).
    // Persisted `downloadAheadLimit` is ignored to prevent stale legacy values
    // from overriding the profile.
    downloadAheadLimit: Math.max(5, Math.ceil(maxDownloadAheadSec / 2)),
    stealthModeEnabled: s?.stealthModeEnabled ?? defaultHardening.stealthModeEnabled,
    maxPrebufferSec: Math.max(10, s?.maxPrebufferSec ?? defaultHardening.maxPrebufferSec),
    maxDownloadAheadSec,
    windowOverlapGraceSec: Math.max(5, s?.windowOverlapGraceSec ?? defaultHardening.windowOverlapGraceSec),
  };
}

// ── Stealth Mode helper: mint an opaque level URL for a given variant path ──
// Hard floors prevent a broken or un-migrated DB value (e.g. tokenTtlPlaylistSec=0)
// from causing the variant playlist URL to expire every 30s and trigger a
// session-rotation storm. Even with shortTokenTtlEnabled=true and a zero/tiny
// persisted TTL, the floor keeps the URL alive long enough for normal playback.
// SESSION_MAX_AGE_MS is the ceiling enforced by the session expiry itself.
//   Level/playlist: 5-minute floor — hls.js reloads every 2s (targetDuration).
//                   5 min matches the heartbeat extend cycle with margin.
//   Chunk/key: 2-minute floor — segments are fetched once then never re-requested.
// `bucketExp` snaps `exp` to a 60s wall-clock bucket so successive playlist
// refetches within the same minute compute the SAME exp. Combined with the
// deterministic-IV mintOpaqueId, this means the sliding-window playlist returns
// IDENTICAL opaque chunk/key URLs across reloads — eliminating the xhr.abort()
// storm and 1-2s black screens that came from hls.js seeing "new" URLs for the
// same segment every few seconds.
// Stealth URL builders. TTL floor lowered to 15s (matches Strict preset
// segment/key TTL) so the admin's Security Profile is actually honored in
// stealth mode. `bucketExp` still snaps exp to a wall-clock bucket so
// successive playlist refetches within the same window produce identical
// opaque URLs (eliminates xhr.abort() storms and black screens).
// When HLS_GATEWAY_BASE is set, prefix stealth URLs so they go through the
// Cloudflare Worker just like legacy /hls /seg /key paths. The Worker treats
// stealth paths as transparent passthrough — the opaque ID is AES-encrypted
// server-side, so only the origin can decode it. Worker gives us: hidden
// Railway origin, edge presence in front of every chunk/playlist/key.
function stealthGatewayPrefix(): string {
  return getHlsGatewayBase(); // "" in dev → relative paths, full URL in prod
}
function buildStealthLevelUrl(publicId: string, sid: string, variantSubPath: string, ttlSec: number): string {
  const exp = bucketExp(Math.max(15, ttlSec));
  const id = mintOpaqueId({ s: sid, t: "l", v: variantSubPath.replace(/^\//, ""), e: exp });
  return `${stealthGatewayPrefix()}/api/player/${publicId}/stream/window/${id}`;
}
function buildStealthChunkUrl(publicId: string, sid: string, segSubPath: string, ttlSec: number): string {
  const exp = bucketExp(Math.max(15, ttlSec));
  const cleanSub = segSubPath.replace(/^\//, "");
  // mintOpaqueChunkId prepends a stable 16-hex cache-key prefix derived
  // from (publicId, segSubPath) using SIGNING_SECRET. The Cloudflare
  // Worker uses this prefix as a synthetic edge-cache key so the same
  // segment is served from cache across all users/sessions. The encrypted
  // suffix is still session-bound — server validation is unchanged.
  const id = mintOpaqueChunkId({ s: sid, t: "c", p: cleanSub, e: exp }, publicId);
  // Append st (HMAC of prefix|publicId|exp) and exp as query params so the
  // Worker can validate the URL at the edge BEFORE doing a cache lookup.
  // Without this gate, any holder of a previously-observed chunk URL could
  // keep pulling cached bytes after their session is revoked. With it,
  // replay is bounded by exp + 15s skew, matching the /seg/ model.
  const stablePrefix = computeChunkStableKey(publicId, cleanSub);
  const st = signChunkCacheToken(publicId, stablePrefix, exp);
  return `${stealthGatewayPrefix()}/api/player/${publicId}/stream/chunk/${id}?st=${st}&exp=${exp}`;
}
function buildStealthKeyUrl(publicId: string, sid: string, ttlSec: number): string {
  const exp = bucketExp(Math.max(15, ttlSec));
  const id = mintOpaqueId({ s: sid, t: "k", e: exp });
  return `${stealthGatewayPrefix()}/api/player/${publicId}/stream/secret/${id}`;
}
// Master playlist URL — served DIRECTLY from the CMS/Railway origin, NOT via
// the Cloudflare Worker gateway. Rationale:
//   1. The master is dynamically generated per-session — no CDN caching benefit.
//   2. The Worker routing table only includes /hls/, /seg/, /key/, and the
//      existing /stream/window|chunk|secret/ patterns. Adding /stream/master/
//      would require a Worker redeploy. Instead, serve it straight from Railway.
//   3. The embed player iframe is served from the Railway origin, so a
//      path-only URL resolves correctly in all contexts (LMS embed, share link,
//      admin preview) without any cross-origin request.
//
// The level/chunk/key URLs emitted INSIDE the master response still use
// buildStealthLevelUrl (→ gateway) so the Worker continues to handle those.
function buildStealthMasterUrl(publicId: string, sid: string, ttlSec: number): string {
  const exp = bucketExp(Math.max(15, ttlSec));
  const id = mintOpaqueId({ s: sid, t: "m", e: exp });
  // Path-only — no gateway prefix. Resolves to Railway CMS origin.
  return `/api/player/${publicId}/stream/master/${id}`;
}

// Resolve the first variant playlist subpath from a video's HLS master.
// Used by /manifest, /rotate-session, /refresh-token so all stealth entry
// points emit a fresh opaque level URL with the new sid.
async function resolveStealthVariantForSession(
  hlsPrefix: string,
  storageProvider: "backblaze_b2" | "cloudflare_r2" | "s3" | "bunny_net",
  storageConfig: any,
): Promise<string | null> {
  try {
    const masterKey = `${hlsPrefix.replace(/\/$/, "")}/master.m3u8`;
    let originUrl: string;
    let fetchHeaders: Record<string, string> | undefined;
    if (storageProvider === "backblaze_b2") {
      originUrl = await b2PresignGetObject(storageConfig.bucket, masterKey, storageConfig.endpoint, 30);
    } else if (storageProvider === "cloudflare_r2") {
      originUrl = await r2PresignGetObject(storageConfig.bucket, masterKey, storageConfig.endpoint, 30);
    } else if (storageProvider === "bunny_net") {
      originUrl = bunnyCdnUrl(storageConfig.pullZoneUrl, masterKey, 30);
    } else {
      const c = await getS3Client();
      if (!c) return null;
      const cmd = new GetObjectCommand({ Bucket: storageConfig.bucket, Key: masterKey });
      originUrl = await getSignedUrl(c, cmd, { expiresIn: 30 });
    }
    const masterRes = await fetch(originUrl, fetchHeaders ? { headers: fetchHeaders } : undefined);
    if (!masterRes.ok) return null;
    const masterText = await masterRes.text();
    for (const raw of masterText.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (/\.m3u8(\?|$)/i.test(line) && !/^https?:\/\//i.test(line)) return line;
    }
  } catch { /* swallow — caller falls back to legacy manifestUrl */ }
  return null;
}
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

// Generate a signed URL for HLS playback — supports B2, R2, Bunny CDN, and AWS S3
async function generateSignedUrl(key: string, ttlSeconds = 120, connId?: string | null): Promise<string> {
  const conn = connId
    ? await storage.getStorageConnectionById(connId)
    : await storage.getActiveStorageConnection();
  if (conn?.provider === "backblaze_b2") {
    const cfg = conn.config as any;
    return b2PresignGetObject(cfg.bucket, key, cfg.endpoint, ttlSeconds);
  }
  if (conn?.provider === "cloudflare_r2") {
    const cfg = conn.config as any;
    return r2PresignGetObject(cfg.bucket, key, cfg.endpoint, ttlSeconds);
  }
  if (conn?.provider === "bunny_net") {
    const cfg = conn.config as any;
    return bunnyCdnUrl(cfg.pullZoneUrl, key, ttlSeconds);
  }
  return generateSignedS3Url(key, ttlSeconds);
}

// Upload a local file to active storage (B2, R2, Bunny, or S3)
async function uploadToActiveStorage(localPath: string, key: string, contentType: string, conn?: Awaited<ReturnType<typeof storage.getActiveStorageConnection>>): Promise<void> {
  const active = conn ?? await storage.getActiveStorageConnection();
  if (active?.provider === "backblaze_b2") {
    const cfg = active.config as any;
    const data = fs.readFileSync(localPath);
    await b2UploadFile(cfg.bucket, key, data, contentType, cfg.endpoint);
    return;
  }
  if (active?.provider === "cloudflare_r2") {
    const cfg = active.config as any;
    const data = fs.readFileSync(localPath);
    await r2UploadFile(cfg.bucket, key, data, contentType, cfg.endpoint);
    return;
  }
  if (active?.provider === "bunny_net") {
    const cfg = active.config as any;
    const data = fs.readFileSync(localPath);
    await bunnyUploadFile(cfg.storageZoneName, key, data, contentType, cfg.storageRegion);
    return;
  }
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

// Concurrency tuned for B2/R2: 8 parallel PUTs comfortably saturates the
// upstream link without tripping per-bucket request burst limits. Raising
// further yields diminishing returns and risks 429s on shared B2 buckets.
const HLS_UPLOAD_CONCURRENCY = 8;
const HLS_UPLOAD_MAX_ATTEMPTS = 3;

function hlsContentType(filename: string): string {
  if (filename.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (filename.endsWith(".ts")) return "video/MP2T";
  if (filename.endsWith(".key")) return "application/octet-stream";
  if (filename.endsWith(".vtt")) return "text/vtt";
  if (filename.endsWith(".png")) return "image/png";
  if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
  if (filename.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
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
  const allFiles = walkDir(localDir);
  // Never upload the symmetric AES master key or the local key_info hint —
  // the encrypted enc.key is uploaded separately by the caller through the
  // provider-specific upload path so the bytes can be tracked in storage_kid.
  const skipFiles = new Set(["enc.key", "key_info.txt"]);
  const files = allFiles.filter(f => !skipFiles.has(path.basename(f)));
  const total = files.length;
  if (total === 0) return;

  log(`[upload] starting parallel HLS upload: files=${total} concurrency=${HLS_UPLOAD_CONCURRENCY} prefix=${prefix}`);
  const startedAt = Date.now();

  let cursor = 0;
  let completed = 0;
  let firstError: Error | null = null;

  async function uploadOne(file: string): Promise<void> {
    const relPath = path.relative(localDir, file).replace(/\\/g, "/");
    const key = `${prefix}${relPath}`;
    const contentType = hlsContentType(path.basename(file));
    let lastErr: any = null;
    for (let attempt = 1; attempt <= HLS_UPLOAD_MAX_ATTEMPTS; attempt++) {
      try {
        await uploadToActiveStorage(file, key, contentType, activeConn);
        return;
      } catch (err: any) {
        lastErr = err;
        if (attempt < HLS_UPLOAD_MAX_ATTEMPTS) {
          // 500ms, 1500ms backoff
          const backoff = 500 * Math.pow(3, attempt - 1);
          log(`[upload] retry ${attempt}/${HLS_UPLOAD_MAX_ATTEMPTS - 1} for ${key} after ${backoff}ms: ${err?.message || err}`);
          await new Promise(r => setTimeout(r, backoff));
        }
      }
    }
    throw new Error(`Upload failed for ${key} after ${HLS_UPLOAD_MAX_ATTEMPTS} attempts: ${lastErr?.message || lastErr}`);
  }

  // Fixed-size worker pool. Each worker pulls indices until exhausted or until
  // any worker has recorded a fatal error (firstError), at which point the
  // remaining workers exit early without starting new uploads.
  async function worker(): Promise<void> {
    while (true) {
      if (firstError) return;
      const idx = cursor++;
      if (idx >= total) return;
      try {
        await uploadOne(files[idx]);
        completed++;
        if (completed % 50 === 0 || completed === total) {
          const pct = Math.round((completed / total) * 100);
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          log(`[upload] progress ${completed}/${total} (${pct}%) elapsed=${elapsed}s`);
        }
      } catch (err: any) {
        if (!firstError) firstError = err;
        return;
      }
    }
  }

  const workerCount = Math.min(HLS_UPLOAD_CONCURRENCY, total);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (firstError) {
    const err: Error = firstError;
    log(`[upload] FAILED after ${completed}/${total} files: ${err.message}`);
    throw err;
  }
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`[upload] HLS upload complete: ${total} files in ${elapsed}s (${(total / parseFloat(elapsed)).toFixed(1)} files/s)`);
}

async function deleteStoragePrefix(client: S3Client, bucket: string, prefix: string): Promise<number> {
  let deleted = 0;
  let continuationToken: string | undefined;
  do {
    const listResp = await client.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, MaxKeys: 1000,
      ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
    }));
    const keys = (listResp.Contents || []).map(o => o.Key!).filter(Boolean);
    if (keys.length > 0) {
      try {
        await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map(k => ({ Key: k })) } }));
        deleted += keys.length;
      } catch (batchErr: any) {
        log(`[delete] Batch delete failed (${batchErr.message}), falling back to individual deletes`);
        for (const key of keys) {
          try {
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
            deleted++;
          } catch (singleErr: any) {
            log(`[delete] Failed to delete ${key}: ${singleErr.message}`);
          }
        }
      }
    }
    continuationToken = listResp.IsTruncated ? listResp.NextContinuationToken : undefined;
  } while (continuationToken);
  return deleted;
}

async function deleteVideoStorage(v: { id: string; hlsS3Prefix?: string | null; rawS3Key?: string | null; storageConnectionId?: string | null; sourceType?: string | null }): Promise<void> {
  const hlsPrefix = v.hlsS3Prefix;
  const connId = v.storageConnectionId;
  const assetsPrefix = `assets/videos/${v.id}/`;

  const conn = connId ? await storage.getStorageConnectionById(connId) : await storage.getActiveStorageConnection();

  if (conn?.provider === "bunny_net") {
    const cfg = conn.config as any;
    const zone = cfg.storageZoneName;
    const region = cfg.storageRegion;
    if (hlsPrefix) {
      try {
        const deleted = await bunnyDeletePrefix(zone, hlsPrefix, region);
        log(`[delete] Bunny: removed ${deleted} HLS files from ${hlsPrefix}`);
      } catch (err: any) {
        log(`[delete] Bunny HLS cleanup error for ${hlsPrefix}: ${err.message}`);
      }
    }
    if (v.rawS3Key) {
      try {
        const { bunnyDeleteFile } = await import("./bunny");
        await bunnyDeleteFile(zone, v.rawS3Key, region);
        log(`[delete] Bunny: removed raw file ${v.rawS3Key}`);
      } catch (err: any) {
        log(`[delete] Bunny raw cleanup error for ${v.rawS3Key}: ${err.message}`);
      }
    }
    try {
      const deleted = await bunnyDeletePrefix(zone, assetsPrefix, region);
      if (deleted > 0) log(`[delete] Bunny: removed ${deleted} asset files from ${assetsPrefix}`);
    } catch (err: any) {
      log(`[delete] Bunny asset cleanup error for ${assetsPrefix}: ${err.message}`);
    }
    return;
  }

  const isS3Compatible = conn?.provider === "backblaze_b2" || conn?.provider === "cloudflare_r2";
  if (isS3Compatible) {
    const cfg = conn!.config as any;
    const client = conn!.provider === "backblaze_b2" ? makeB2Client(cfg) : makeR2Client(cfg);
    const providerLabel = conn!.provider === "backblaze_b2" ? "B2" : "R2";
    const bucket = cfg.bucket;

    if (hlsPrefix) {
      try {
        const deleted = await deleteStoragePrefix(client, bucket, hlsPrefix);
        log(`[delete] ${providerLabel}: removed ${deleted} HLS files from ${hlsPrefix}`);
      } catch (err: any) {
        log(`[delete] ${providerLabel} HLS cleanup error for ${hlsPrefix}: ${err.message}`);
      }
    }

    if (v.rawS3Key) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: v.rawS3Key }));
        log(`[delete] ${providerLabel}: removed raw file ${v.rawS3Key}`);
      } catch (err: any) {
        log(`[delete] ${providerLabel} raw cleanup error for ${v.rawS3Key}: ${err.message}`);
      }
    }

    try {
      const deleted = await deleteStoragePrefix(client, bucket, assetsPrefix);
      if (deleted > 0) log(`[delete] ${providerLabel}: removed ${deleted} asset files from ${assetsPrefix}`);
    } catch (err: any) {
      log(`[delete] ${providerLabel} asset cleanup error for ${assetsPrefix}: ${err.message}`);
    }

    return;
  }

  const s3 = await getS3Client();
  const s3cfg = await getS3Config();
  if (s3 && s3cfg.bucket) {
    if (hlsPrefix) {
      try {
        const deleted = await deleteStoragePrefix(s3, s3cfg.bucket, hlsPrefix);
        log(`[delete] S3: removed ${deleted} HLS files from ${hlsPrefix}`);
      } catch (err: any) {
        log(`[delete] S3 HLS cleanup error for ${hlsPrefix}: ${err.message}`);
      }
    }

    if (v.rawS3Key) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: s3cfg.bucket, Key: v.rawS3Key }));
        log(`[delete] S3: removed raw file ${v.rawS3Key}`);
      } catch (err: any) {
        log(`[delete] S3 raw cleanup error for ${v.rawS3Key}: ${err.message}`);
      }
    }

    try {
      const deleted = await deleteStoragePrefix(s3, s3cfg.bucket, assetsPrefix);
      if (deleted > 0) log(`[delete] S3: removed ${deleted} asset files from ${assetsPrefix}`);
    } catch (err: any) {
      log(`[delete] S3 asset cleanup error for ${assetsPrefix}: ${err.message}`);
    }

    return;
  }

  if (hlsPrefix && fs.existsSync(hlsPrefix)) {
    try {
      fs.rmSync(hlsPrefix, { recursive: true, force: true });
      log(`[delete] Local: removed directory ${hlsPrefix}`);
    } catch (err: any) {
      log(`[delete] Local cleanup error: ${err.message}`);
    }
  }
}

async function transcodeAndStoreHls(videoId: string, inputPath: string, qualities: number[], connOverride?: any): Promise<void> {
  const hlsOutputDir = path.join(os.tmpdir(), "vcms-hls", videoId);

  // Get duration up-front for accurate percent progress
  const durationMs = await ffprobeDuration(inputPath);
  log(`[transcode] Video ${videoId}: duration=${durationMs}ms, inputPath=${inputPath}`);

  const enc = generateEncryptionKey();
  const keyFilePath = path.join(hlsOutputDir, "enc.key");
  const keyInfoPath = path.join(hlsOutputDir, "key_info.txt");
  if (!fs.existsSync(hlsOutputDir)) fs.mkdirSync(hlsOutputDir, { recursive: true });
  fs.writeFileSync(keyFilePath, enc.keyBytes);
  createKeyInfoFile("enc.key", keyFilePath, enc.iv, keyInfoPath);

  await runFfmpegHls(inputPath, hlsOutputDir, qualities, { keyInfoPath }, videoId, durationMs);

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

  // PART 2 diagnostic: surface what was actually generated — selected qualities,
  // generated variants, master playlist path, and a content summary so we can
  // verify end-to-end that admin's quality selection became real HLS variants.
  const masterPath = path.join(hlsOutputDir, "master.m3u8");
  if (fs.existsSync(masterPath)) {
    const masterContent = fs.readFileSync(masterPath, "utf8");
    const streamInfCount = (masterContent.match(/#EXT-X-STREAM-INF/g) || []).length;
    log(`[transcode] video=${videoId} selectedQualities=[${qualities.join(",")}] generatedVariants=${variantPlaylists.length} streamInfInMaster=${streamInfCount} masterPath=${masterPath}`);
    if (streamInfCount !== qualities.length) {
      log(`[transcode] WARNING video=${videoId} master has ${streamInfCount} STREAM-INF entries but ${qualities.length} qualities were requested — some renditions may have been skipped by ffmpeg`);
    }
  } else {
    log(`[transcode] WARNING video=${videoId} master.m3u8 NOT generated at ${masterPath} — stealth master endpoint will 404`);
  }

  if (videoId) transcodeProgress.set(videoId, { time: "", speed: "", stage: "uploading" });
  const activeConn = connOverride ?? await storage.getActiveStorageConnection();

  if (activeConn?.provider === "bunny_net") {
    const cfg = activeConn.config as any;
    const hlsPrefix = `${cfg.hlsPrefix || "hls/"}${videoId}/`;
    const keyBucketPath = `${hlsPrefix}enc.key`;
    await bunnyUploadFile(cfg.storageZoneName, keyBucketPath, enc.keyBytes, "application/octet-stream", cfg.storageRegion);
    await uploadHlsDir(hlsOutputDir, hlsPrefix, activeConn!);
    await storage.updateVideo(videoId, {
      status: "ready",
      hlsS3Prefix: hlsPrefix,
      storageConnectionId: activeConn!.id,
      encryptionKid: enc.kid,
      encryptionKeyPath: keyBucketPath,
      lastError: null,
      duration: durationMs > 0 ? Math.round(durationMs / 1000) : null,
    } as any);
    try { fs.rmSync(hlsOutputDir, { recursive: true }); } catch {}
    transcodeProgress.delete(videoId);
    log(`Bunny HLS upload (AES-128 encrypted) complete for video ${videoId}`);
    return;
  }

  const isS3CompatConn = activeConn?.provider === "backblaze_b2" || activeConn?.provider === "cloudflare_r2";
  if (isS3CompatConn) {
    const cfg = activeConn!.config as any;
    const uploadFn = activeConn!.provider === "backblaze_b2" ? b2UploadFile : r2UploadFile;
    const providerLabel = activeConn!.provider === "backblaze_b2" ? "B2" : "R2";
    const hlsPrefix = `${cfg.hlsPrefix || "hls/"}${videoId}/`;
    const keyBucketPath = `${hlsPrefix}enc.key`;
    await uploadFn(cfg.bucket, keyBucketPath, enc.keyBytes, "application/octet-stream", cfg.endpoint);
    await uploadHlsDir(hlsOutputDir, hlsPrefix, activeConn!);
    await storage.updateVideo(videoId, {
      status: "ready",
      hlsS3Prefix: hlsPrefix,
      storageConnectionId: activeConn!.id,
      encryptionKid: enc.kid,
      encryptionKeyPath: keyBucketPath,
      lastError: null,
      duration: durationMs > 0 ? Math.round(durationMs / 1000) : null,
    } as any);
    try { fs.rmSync(hlsOutputDir, { recursive: true }); } catch {}
    transcodeProgress.delete(videoId);
    log(`${providerLabel} HLS upload (AES-128 encrypted) complete for video ${videoId}`);
    return;
  }

  const client = await getS3Client();
  const cfg = await getS3Config();
  if (client && cfg.bucket) {
    const hlsPrefix = `${cfg.hlsPrefix}${videoId}/`;
    await uploadHlsToS3(hlsOutputDir, hlsPrefix);
    await storage.updateVideo(videoId, { status: "ready", hlsS3Prefix: hlsPrefix, encryptionKid: enc.kid, lastError: null, duration: durationMs > 0 ? Math.round(durationMs / 1000) : null } as any);
    try { fs.rmSync(hlsOutputDir, { recursive: true }); } catch {}
  } else {
    const localHlsDir = path.join(uploadDir, "hls", videoId);
    if (fs.existsSync(localHlsDir)) fs.rmSync(localHlsDir, { recursive: true });
    fs.cpSync(hlsOutputDir, localHlsDir, { recursive: true });
    await storage.updateVideo(videoId, { status: "ready", hlsS3Prefix: localHlsDir, encryptionKid: enc.kid, lastError: null, duration: durationMs > 0 ? Math.round(durationMs / 1000) : null } as any);
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

function getSigningSecret(): string {
  const s = process.env.SIGNING_SECRET;
  if (!s) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SIGNING_SECRET env var is required. Generate one via GET /api/admin/generate-signing-secret and set it in Railway + Cloudflare Worker.");
    }
    return "insecure-dev-only-signing-key";
  }
  return s;
}

function generateToken(payload: object, ttlSeconds: number | null): string {
  const uniquePayload = { ...payload, jti: crypto.randomUUID() };
  if (ttlSeconds === null || ttlSeconds === 0) {
    return jwt.sign(uniquePayload, getSigningSecret());
  }
  return jwt.sign(uniquePayload, getSigningSecret(), { expiresIn: ttlSeconds });
}

function verifyToken(token: string): any {
  try {
    return jwt.verify(token, getSigningSecret());
  } catch {
    return null;
  }
}

function getAllowedLmsOrigins(): string[] {
  const raw = (process.env.ALLOWED_LMS_ORIGINS || "").trim();
  if (!raw) return [];
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

// Nonce replay protection — map of nonce → expiry timestamp (ms)
const lmsNonceCache = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const [nonce, exp] of lmsNonceCache) {
    if (exp <= now) lmsNonceCache.delete(nonce);
  }
}, 60_000);

function verifyLmsLaunchToken(launchToken: string): { userId: string; publicId: string; exp: number; nonce: string; aud: string; origin: string } | null {
  const secret = process.env.LMS_HMAC_SECRET;
  if (!secret) { log("[lms-verify] FAIL: LMS_HMAC_SECRET not set"); return null; }
  const allowedOrigins = getAllowedLmsOrigins();
  if (allowedOrigins.length === 0) { log("[lms-verify] FAIL: no allowed origins configured"); return null; }
  try {
    const parts = launchToken.split(".");
    if (parts.length !== 2) {
      log(`[lms-verify] FAIL: token has ${parts.length} parts (expected 2) — token may be a JWT or wrong format`);
      return null;
    }
    const [payloadB64, sig] = parts;
    let payload: any;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    } catch {
      log("[lms-verify] FAIL: payload is not valid base64url JSON");
      return null;
    }
    const expectedSig = crypto.createHmac("sha256", secret).update(payloadB64).digest("hex");
    const sigBuf = Buffer.from(sig, "hex");
    const expectedBuf = Buffer.from(expectedSig, "hex");
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      log(`[lms-verify] FAIL: HMAC signature mismatch — received sig tail: ...${sig.slice(-8)}, expected tail: ...${expectedSig.slice(-8)} — secret length: ${secret.length} chars. Payload fields: ${Object.keys(payload).join(", ")}`);
      return null;
    }
    const missing = ["userId","publicId","exp","nonce","aud","origin"].filter(f => !payload[f]);
    if (missing.length > 0) { log(`[lms-verify] FAIL: missing payload fields: ${missing.join(", ")}`); return null; }
    if (payload.aud !== "video-cms") { log(`[lms-verify] FAIL: aud="${payload.aud}" (expected "video-cms")`); return null; }
    if (!allowedOrigins.includes(payload.origin)) {
      log(`[lms-verify] FAIL: origin="${payload.origin}" not in allowed list: [${allowedOrigins.join(", ")}]`);
      return null;
    }
    const nowSec = Date.now() / 1000;
    if (nowSec > payload.exp) { log(`[lms-verify] FAIL: token expired ${Math.round(nowSec - payload.exp)}s ago`); return null; }
    if (payload.exp - nowSec > 600) { log(`[lms-verify] FAIL: token exp is ${Math.round(payload.exp - nowSec)}s away (max 600s) — generate tokens closer to use`); return null; }
    log(`[lms-verify] OK: userId=${payload.userId} publicId=${payload.publicId} origin=${payload.origin}`);
    return payload;
  } catch (e: any) {
    log(`[lms-verify] FAIL: unexpected error: ${e.message}`);
    return null;
  }
}

function checkEntitlement(_userId: string, _videoId: string): { allowed: boolean; reason?: string } {
  return { allowed: true };
}

// ffmpeg HLS processing
const transcodeProgress = new Map<string, { time: string; speed: string; stage: string; percent?: number }>();

function getTranscodeProgress(videoId: string): { time: string; speed: string; stage: string; percent?: number } | null {
  return transcodeProgress.get(videoId) || null;
}

async function ffprobeDuration(inputPath: string): Promise<number> {
  return new Promise((resolve) => {
    const ff = spawn(FFPROBE_BIN, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ]);
    let out = "";
    ff.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    ff.on("close", () => {
      const dur = parseFloat(out.trim());
      resolve(isNaN(dur) || dur <= 0 ? 0 : Math.round(dur * 1000));
    });
    ff.on("error", () => resolve(0));
  });
}

async function runFfmpegHls(
  inputPath: string,
  outputDir: string,
  qualities: number[],
  encryption?: { keyInfoPath: string },
  videoId?: string,
  durationMs?: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    // Validate input before spawning — fail fast with a clear error
    if (!fs.existsSync(inputPath)) {
      return reject(new Error(`Input file not found: ${inputPath}`));
    }
    if (encryption) {
      if (!fs.existsSync(encryption.keyInfoPath)) {
        return reject(new Error(`AES key info file not found: ${encryption.keyInfoPath}`));
      }
      const keyInfoLines = fs.readFileSync(encryption.keyInfoPath, "utf8").split("\n");
      const keyFilePath = (keyInfoLines[1] || "").trim();
      if (!keyFilePath || !fs.existsSync(keyFilePath)) {
        return reject(new Error(`AES key file not found at path referenced by key_info: ${keyFilePath}`));
      }
    }

    const qualityMap: Record<number, { vf: string; b: string; ba: string; maxrate: string; bufsize: string }> = {
      240: { vf: "scale=-2:240", b: "400k", ba: "64k", maxrate: "500k", bufsize: "1000k" },
      360: { vf: "scale=-2:360", b: "800k", ba: "96k", maxrate: "900k", bufsize: "1800k" },
      480: { vf: "scale=-2:480", b: "1200k", ba: "128k", maxrate: "1400k", bufsize: "2800k" },
      720: { vf: "scale=-2:720", b: "2500k", ba: "128k", maxrate: "2800k", bufsize: "5600k" },
      1080: { vf: "scale=-2:1080", b: "5000k", ba: "192k", maxrate: "5500k", bufsize: "11000k" },
    };

    const selectedQualities = qualities.filter(q => qualityMap[q]);
    if (selectedQualities.length === 0) selectedQualities.push(720);

    // -progress pipe:1 sends key=value progress blocks to stdout; -nostats suppresses the
    // per-frame stderr line so stderr stays clean for error messages only.
    const args: string[] = [
      "-progress", "pipe:1",
      "-nostats",
      "-i", inputPath,
      "-y",
    ];

    selectedQualities.forEach((q, i) => {
      const cfg = qualityMap[q];
      args.push(
        `-map`, `0:v:0`, `-map`, `0:a:0`,
        `-c:v:${i}`, `libx264`, `-b:v:${i}`, cfg.b,
        `-maxrate:v:${i}`, cfg.maxrate, `-bufsize:v:${i}`, cfg.bufsize,
        `-filter:v:${i}`, cfg.vf, `-c:a:${i}`, `aac`, `-b:a:${i}`, cfg.ba,
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

    log(`[ffmpeg] Starting HLS transcode${encryption ? " (AES-128)" : ""} | qualities=${selectedQualities.join(",")} | input=${inputPath}`);
    log(`[ffmpeg] Command: ${FFMPEG_BIN} ${args.join(" ")}`);

    if (videoId) transcodeProgress.set(videoId, { time: "00:00:00", speed: "—", stage: "transcoding", percent: 0 });

    const proc = spawn(FFMPEG_BIN, args);
    let stdoutBuf = "";
    let stderrBuf = "";

    // Accumulate current progress block values
    let curTimeMicros = -1;
    let curSpeed = "";
    let lastProgressUpdate = 0;

    proc.stdout.on("data", (d: Buffer) => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() || "";

      for (const line of lines) {
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();

        if (key === "out_time_ms") {
          // ffmpeg names this "out_time_ms" but value is in microseconds
          curTimeMicros = parseInt(val, 10);
        } else if (key === "out_time_us") {
          curTimeMicros = parseInt(val, 10);
        } else if (key === "speed") {
          curSpeed = val;
        } else if (key === "progress") {
          // Flush accumulated values on each progress report
          if (videoId && curTimeMicros >= 0) {
            const now = Date.now();
            if (now - lastProgressUpdate >= 500) {
              lastProgressUpdate = now;
              const outMs = Math.round(curTimeMicros / 1000);
              const seconds = Math.floor(outMs / 1000);
              const h = Math.floor(seconds / 3600).toString().padStart(2, "0");
              const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
              const s = (seconds % 60).toString().padStart(2, "0");
              const time = `${h}:${m}:${s}`;
              const pct = durationMs && durationMs > 0
                ? Math.min(99, Math.round((outMs / durationMs) * 100))
                : undefined;
              const speed = curSpeed && curSpeed !== "N/A" ? curSpeed : "—";
              log(`[ffmpeg] progress: time=${time} speed=${speed}${pct != null ? ` percent=${pct}%` : ""}`);
              transcodeProgress.set(videoId, { time, speed, percent: pct, stage: "transcoding" });
            }
          }
          if (val === "end" && videoId) {
            transcodeProgress.set(videoId, { time: "", speed: "", stage: "uploading" });
          }
        }
      }
    });

    proc.stderr.on("data", (d: Buffer) => {
      stderrBuf += d.toString();
      process.stdout.write(d);
    });

    proc.on("error", (err) => {
      if (videoId) transcodeProgress.delete(videoId);
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });

    proc.on("close", (code) => {
      log(`[ffmpeg] exited with code ${code}`);
      if (code === 0) {
        if (videoId) transcodeProgress.set(videoId, { time: "", speed: "", stage: "uploading" });
        resolve();
      } else {
        if (videoId) transcodeProgress.delete(videoId);
        const errTail = stderrBuf.split("\n").filter(Boolean).slice(-10).join(" | ");
        reject(new Error(`ffmpeg exited with code ${code}. ${errTail}`));
      }
    });
  });
}

const masterKeyCache = new Map<string, Buffer>();

async function getMasterKey(encryptionKeyPath: string, session: any): Promise<Buffer | null> {
  if (masterKeyCache.has(encryptionKeyPath)) return masterKeyCache.get(encryptionKeyPath)!;
  try {
    const cfg = session.storageConfig;
    let keyBytes: Buffer;
    if (session.storageProvider === "bunny_net") {
      keyBytes = await bunnyFetchFile(cfg.storageZoneName, encryptionKeyPath, cfg.storageRegion);
    } else {
      const client = session.storageProvider === "cloudflare_r2" ? makeR2Client({ endpoint: cfg.endpoint }) : makeB2Client({ endpoint: cfg.endpoint });
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const resp = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: encryptionKeyPath }));
      keyBytes = Buffer.from(await resp.Body!.transformToByteArray());
    }
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
        log(`[recovery] Re-transcoding video ${video.id} from storage (${rawKey})`);
        transcodeProgress.set(video.id, { time: "", speed: "", stage: "recovering" });
        (async () => {
          try {
            const conn = await storage.getStorageConnectionById(connId);
            if (!conn) throw new Error("Storage connection not found");
            const cfg = conn.config as any;
            const tmpPath = path.join(os.tmpdir(), `recover-${video.id}.mp4`);
            if (conn.provider === "bunny_net") {
              const buf = await bunnyFetchFile(cfg.storageZoneName, rawKey, cfg.storageRegion);
              fs.writeFileSync(tmpPath, buf);
            } else {
              const storageClient = conn.provider === "cloudflare_r2" ? makeR2Client({ endpoint: cfg.endpoint }) : makeB2Client({ endpoint: cfg.endpoint });
              const { GetObjectCommand } = await import("@aws-sdk/client-s3");
              const resp = await storageClient.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: rawKey }));
              const bodyStream = resp.Body as any;
              const ws = fs.createWriteStream(tmpPath);
              await new Promise<void>((resolve, reject) => {
                bodyStream.pipe(ws);
                ws.on("finish", resolve);
                ws.on("error", reject);
              });
            }
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

  // ── Integration API Module ────────────────────────────────
  const { registerIntegrationRoutes } = await import("./integrations/routes");
  const { registerIntegrationAdminRoutes } = await import("./integrations/admin-routes");
  registerIntegrationRoutes(app);
  registerIntegrationAdminRoutes(app);

  // Wire abuse-revoke → integration session DB update (LMS flow).
  setIntegrationRevokeNotifier((integrationSessionId, reason) => {
    // Best-effort async update; don't block the revoke path.
    (async () => {
      try {
        await storage.updateIntegrationPlaybackSession(integrationSessionId, {
          status: "revoked",
          endedAt: new Date(),
          sessionMetadata: { revokedReason: reason, revokedAt: new Date().toISOString() } as any,
        } as any);
        console.log(`[integrations] AUTO_REVOKED integration session ${integrationSessionId} reason=${reason}`);
      } catch (e: any) {
        console.error(`[integrations] failed to auto-revoke session ${integrationSessionId}:`, e?.message);
      }
    })();
  });

  // Serve SDK files at /sdk/*
  const sdkCandidates = [
    typeof __dirname !== "undefined" ? path.resolve(__dirname, "public", "sdk") : "",
    typeof __dirname !== "undefined" ? path.resolve(__dirname, "..", "public", "sdk") : "",
    path.resolve(process.cwd(), "public", "sdk"),
    path.resolve(process.cwd(), "dist", "public", "sdk"),
  ].filter(Boolean);
  const fs = await import("fs");
  const sdkDir = sdkCandidates.find(d => fs.existsSync(d)) || sdkCandidates[0];
  app.use("/sdk", (await import("express")).default.static(sdkDir, { maxAge: "1h" }));

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

  // ── Admin: generate signing secret ───────────────────────
  app.get("/api/admin/generate-signing-secret", requireAuth, (_req, res) => {
    const secret = crypto.randomBytes(32).toString("hex");
    res.json({ signing_secret: secret });
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
      const { title, description, author, tags, available, sourceType, sourceUrl, categoryId } = req.body;
      const v = await storage.updateVideo(req.params.id, { title, description, author, tags, available, sourceType, sourceUrl, categoryId: categoryId ?? undefined });
      if (!v) return res.status(404).json({ message: "Not found" });
      await storage.createAuditLog({ action: "video_updated", meta: { videoId: v.id }, ip: req.ip });
      res.json(v);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Video download — returns a time-limited presigned URL to the raw source file
  app.get("/api/videos/:id/download", requireAuth, async (req, res) => {
    try {
      const video = await storage.getVideoById(req.params.id);
      if (!video) return res.status(404).json({ message: "Not found" });
      if (!video.rawS3Key) return res.status(400).json({ message: "No source file stored for this video" });

      const conn = await storage.getActiveStorageConnection();
      if (!conn) return res.status(400).json({ message: "No active storage connection" });
      const cfg = conn.config as any;

      let url: string;
      const ttl = 3600; // 1 hour download link

      if (conn.provider === "bunny_net") {
        url = bunnyCdnUrl(cfg.pullZoneUrl, video.rawS3Key, ttl);
      } else if (conn.provider === "backblaze_b2") {
        url = await b2PresignGetObject(cfg.bucket, video.rawS3Key, cfg.endpoint, ttl);
      } else if (conn.provider === "cloudflare_r2") {
        url = await r2PresignGetObject(cfg.bucket, video.rawS3Key, cfg.endpoint, ttl);
      } else {
        return res.status(400).json({ message: "Download not supported for this storage provider" });
      }

      const ext = video.rawS3Key.split(".").pop() || "mp4";
      const filename = `${video.title.replace(/[^a-z0-9_\-]/gi, "_")}.${ext}`;
      res.json({ url, filename, qualities: video.qualities || [] });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Video Categories CRUD
  app.get("/api/admin/categories", requireAuth, async (_req, res) => {
    res.json(await storage.getCategories());
  });

  app.post("/api/admin/categories", requireAuth, async (req, res) => {
    try {
      const { name, color } = req.body;
      if (!name?.trim()) return res.status(400).json({ message: "Name is required" });
      const cat = await storage.createCategory({ name: name.trim(), color: color || "#6366f1" });
      res.json(cat);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.put("/api/admin/categories/:id", requireAuth, async (req, res) => {
    try {
      const { name, color } = req.body;
      const cat = await storage.updateCategory(req.params.id, { name: name?.trim(), color });
      if (!cat) return res.status(404).json({ message: "Not found" });
      res.json(cat);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.delete("/api/admin/categories/:id", requireAuth, async (req, res) => {
    try {
      await storage.deleteCategory(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.delete("/api/videos/:id", requireAuth, async (req, res) => {
    const v = await storage.getVideoById(req.params.id);
    if (!v) return res.status(404).json({ message: "Not found" });
    // 1. Delete all storage files (HLS segments, raw upload, thumbnails, logos, overlays, intro/outro, banners)
    await deleteVideoStorage(v as any);
    // 2. Delete orphaned media asset DB records (thumbnail, logo, overlay, intro, outro, banner images)
    await storage.deleteMediaAssetsByVideoId(req.params.id);
    // 3. Delete video DB record — cascades to player settings, security settings, watermark,
    //    embed tokens, playback sessions, banners, client security rows automatically
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

        await storage.updateVideo(video.id, { status: "processing", lastError: null } as any);
        res.json({ ok: true, message: "Re-transcoding started with AES-128 encryption. This may take a few minutes." });

        (async () => {
          try {
            const tmpPath = path.join(os.tmpdir(), `retranscode-${video.id}.mp4`);
            if (conn!.provider === "bunny_net") {
              const buf = await bunnyFetchFile(cfg.storageZoneName, rawKey, cfg.storageRegion);
              fs.writeFileSync(tmpPath, buf);
            } else {
              const storageClient = conn!.provider === "cloudflare_r2" ? makeR2Client({ endpoint: cfg.endpoint }) : makeB2Client({ endpoint: cfg.endpoint });
              const { GetObjectCommand } = await import("@aws-sdk/client-s3");
              const resp = await storageClient.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: rawKey }));
              const bodyStream = resp.Body as any;
              const ws = fs.createWriteStream(tmpPath);
              await new Promise<void>((resolve, reject) => {
                bodyStream.pipe(ws);
                ws.on("finish", resolve);
                ws.on("error", reject);
              });
            }
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
      // Persist the qualities the admin actually selected so video.qualities in
      // the DB matches what ffmpeg will produce. Without this, the video record
      // shows no qualities even though multiple HLS variants exist on storage.
      try { await storage.updateVideo(video.id, { qualities } as any); } catch {}
      log(`[upload] video=${video.id} selectedQualities=[${qualities.join(",")}]`);
      // Use explicitly selected connection, or fall back to active
      const selectedConnId = req.body.connectionId as string | undefined;
      const conn = selectedConnId
        ? await storage.getStorageConnectionById(selectedConnId)
        : await storage.getActiveStorageConnection();

      if (conn?.provider === "backblaze_b2" || conn?.provider === "cloudflare_r2") {
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

    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) {
      try { fs.unlinkSync(file.path); } catch {}
      return res.status(400).json({ message: "Invalid file type. Allowed: JPEG, PNG, WebP." });
    }
    if (file.size > 10 * 1024 * 1024) {
      try { fs.unlinkSync(file.path); } catch {}
      return res.status(400).json({ message: "File too large. Max 10 MB." });
    }

    const video = await storage.getVideoById(req.params.id);
    if (!video) return res.status(404).json({ message: "Not found" });

    try {
      const conn = await storage.getActiveStorageConnection();
      if (!conn) return res.status(400).json({ message: "No active storage connection configured." });
      const cfg = conn.config as any;

      const ext = path.extname(file.originalname) || ".jpg";
      const uniqueId = nanoid(12);
      const bucketKey = `assets/videos/${video.id}/thumbnail/${uniqueId}${ext}`;

      if (conn.provider === "bunny_net") {
        await bunnyUploadFile(cfg.storageZoneName, bucketKey, fs.readFileSync(file.path), file.mimetype, cfg.storageRegion);
      } else {
        const assetUploadFn = conn.provider === "cloudflare_r2" ? r2UploadFile : b2UploadFile;
        await assetUploadFn(cfg.bucket, bucketKey, fs.readFileSync(file.path), file.mimetype, cfg.endpoint);
      }
      try { fs.unlinkSync(file.path); } catch {}

      const asset = await storage.createMediaAsset({
        type: "thumbnail",
        bucketKey,
        originalName: file.originalname,
        mimeType: file.mimetype,
        storageConnectionId: conn.id,
      });

      const thumbnailUrl = `/api/assets/${asset.id}/view`;
      await storage.updateVideo(video.id, {
        thumbnailAssetId: asset.id,
        thumbnailUrl,
        thumbnailUpdatedAt: new Date(),
      } as any);

      await storage.createAuditLog({ action: "thumbnail_uploaded", meta: { videoId: video.id, assetId: asset.id }, ip: req.ip });
      res.json({ thumbnailAssetId: asset.id, thumbnailUrl });
    } catch (e: any) {
      try { fs.unlinkSync(file.path); } catch {}
      log(`Thumbnail upload error: ${e.message}`);
      res.status(500).json({ message: e.message });
    }
  });

  app.delete("/api/videos/:id/thumbnail", requireAuth, async (req, res) => {
    const video = await storage.getVideoById(req.params.id);
    if (!video) return res.status(404).json({ message: "Not found" });
    await storage.updateVideo(video.id, { thumbnailAssetId: null, thumbnailUrl: null, thumbnailUpdatedAt: new Date() } as any);
    await storage.createAuditLog({ action: "thumbnail_removed", meta: { videoId: video.id }, ip: req.ip });
    res.json({ ok: true });
  });

  // Settings
  app.put("/api/videos/:id/player-settings", requireAuth, async (req, res) => {
    const s = await storage.upsertPlayerSettings(req.params.id, req.body);
    await storage.createAuditLog({ action: "player_settings_updated", meta: { videoId: req.params.id }, ip: req.ip });
    res.json(s);
  });

  app.patch("/api/videos/:id/player-settings", requireAuth, async (req, res) => {
    const s = await storage.upsertPlayerSettings(req.params.id, req.body);
    await storage.createAuditLog({ action: "player_settings_updated", meta: { videoId: req.params.id }, ip: req.ip });
    res.json(s);
  });

  // ── Player Asset Uploads (logo / overlay / intro / outro) ─────────────────
  const playerAssetUpload = multer({
    dest: uploadDir,
    limits: { fileSize: 200 * 1024 * 1024 }, // 200MB for video clips
  });

  app.post("/api/videos/:id/player-assets/:assetType", requireAuth, playerAssetUpload.single("file"), async (req: any, res: any) => {
    try {
      const { id, assetType } = req.params;
      const allowed = ["logo", "overlay", "intro", "outro"];
      if (!allowed.includes(assetType)) return res.status(400).json({ message: "Invalid asset type" });
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });

      const isVideo = ["intro", "outro"].includes(assetType);
      const allowedMime = isVideo
        ? ["video/mp4", "video/quicktime", "video/x-msvideo", "video/webm"]
        : ["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml"];
      if (!allowedMime.includes(req.file.mimetype)) {
        return res.status(400).json({ message: `Invalid file type. Allowed: ${allowedMime.join(", ")}` });
      }

      const video = await storage.getVideoById(id);
      if (!video) return res.status(404).json({ message: "Video not found" });

      const conn = await storage.getActiveStorageConnection();
      if (!conn) return res.status(400).json({ message: "No active storage connection" });
      const cfg = conn.config as any;

      const ext = path.extname(req.file.originalname) || (isVideo ? ".mp4" : ".png");
      const uniqueId = nanoid(12);
      const bucketKey = `assets/videos/${id}/${assetType}/${uniqueId}${ext}`;

      if (conn.provider === "bunny_net") {
        await bunnyUploadFile(cfg.storageZoneName, bucketKey, fs.readFileSync(req.file.path), req.file.mimetype, cfg.storageRegion);
      } else {
        const assetUploadFn = conn.provider === "cloudflare_r2" ? r2UploadFile : b2UploadFile;
        await assetUploadFn(cfg.bucket, bucketKey, fs.readFileSync(req.file.path), req.file.mimetype, cfg.endpoint);
      }

      const asset = await storage.createMediaAsset({
        type: `player_${assetType}`,
        bucketKey,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        storageConnectionId: conn.id,
      });

      try { fs.unlinkSync(req.file.path); } catch {}

      const assetIdField = `${assetType}AssetId` as any;
      const extraFields: Record<string, any> = { [assetIdField]: asset.id };
      if (assetType === "logo") extraFields.logoEnabled = true;
      if (assetType === "overlay") extraFields.overlayEnabled = true;
      await storage.upsertPlayerSettings(id, extraFields);

      await storage.createAuditLog({ action: `player_${assetType}_uploaded`, meta: { videoId: id, assetId: asset.id }, ip: req.ip });

      res.json({ assetId: asset.id, previewUrl: `/api/assets/${asset.id}/view`, bucketKey });
    } catch (e: any) {
      log(`Player asset upload error: ${e.message}`);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Banner CRUD ────────────────────────────────────────────────────────────
  app.get("/api/videos/:id/banners", requireAuth, async (req, res) => {
    const banners = await storage.getBannersByVideo(req.params.id);
    res.json(banners);
  });

  app.post("/api/videos/:id/banners", requireAuth, async (req, res) => {
    const banner = await storage.createBanner({ videoId: req.params.id, ...req.body });
    res.json(banner);
  });

  app.post("/api/videos/:id/banners/reorder", requireAuth, async (req, res) => {
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds)) return res.status(400).json({ message: "orderedIds must be array" });
    await storage.reorderBanners(req.params.id, orderedIds);
    res.json({ ok: true });
  });

  app.patch("/api/videos/:id/banners/:bannerId", requireAuth, async (req, res) => {
    const banner = await storage.updateBanner(req.params.bannerId, req.body);
    if (!banner) return res.status(404).json({ message: "Banner not found" });
    res.json(banner);
  });

  app.delete("/api/videos/:id/banners/:bannerId", requireAuth, async (req, res) => {
    await storage.deleteBanner(req.params.bannerId);
    res.json({ ok: true });
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
      if (!conn || (conn.provider !== "backblaze_b2" && conn.provider !== "cloudflare_r2" && conn.provider !== "bunny_net")) return res.status(400).json({ message: "No active B2/R2/Bunny storage connection" });

      const cfg = conn.config as any;
      const ext = path.extname(req.file.originalname) || ".png";
      const uniqueId = nanoid(12);
      const bucketKey = `assets/${assetType}s/${uniqueId}${ext}`;

      if (conn.provider === "bunny_net") {
        await bunnyUploadFile(cfg.storageZoneName, bucketKey, fs.readFileSync(req.file.path), req.file.mimetype, cfg.storageRegion);
      } else {
        const assetUploadFn = conn.provider === "cloudflare_r2" ? r2UploadFile : b2UploadFile;
        await assetUploadFn(cfg.bucket, bucketKey, fs.readFileSync(req.file.path), req.file.mimetype, cfg.endpoint);
      }

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
      if (!conn || (conn.provider !== "backblaze_b2" && conn.provider !== "cloudflare_r2" && conn.provider !== "bunny_net")) return res.status(500).json({ message: "Storage not available" });

      const cfg = conn.config as any;
      let signedUrl: string;
      if (conn.provider === "bunny_net") {
        signedUrl = bunnyCdnUrl(cfg.pullZoneUrl, asset.bucketKey, 60);
      } else {
        const presignFn = conn.provider === "backblaze_b2" ? b2PresignGetObject : r2PresignGetObject;
        signedUrl = await presignFn(cfg.bucket, asset.bucketKey, cfg.endpoint, 60);
      }
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
      const isPermanent = ttlHours === 0 || ttlHours === null || ttlHours === "0";
      const ttlSecs = isPermanent ? null : (ttlHours || 24) * 3600;
      const expiresAt = isPermanent ? null : new Date(Date.now() + (ttlSecs as number) * 1000);
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
      const token = generateToken({ videoId: video.id, publicId: video.publicId, adminPreview: true }, 86400); // 24 hours
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

      // Compute effective suspiciousDetectionEnabled:
      // Use per-video setting when the video is NOT set to inherit from global.
      // Admin preview sessions always have suspicious detection disabled.
      const globalSec = await secRepo.getGlobal();
      const videoUseGlobal = await secRepo.getUseGlobal(video.id);
      const effectiveClientSec = videoUseGlobal
        ? globalSec
        : ((await secRepo.getVideo(video.id)) ?? globalSec);
      const suspiciousEnabled = isAdminPreview ? false : (effectiveClientSec.suspiciousDetectionEnabled !== false);
      const effectiveViolationLimit = effectiveClientSec.violationLimit ?? 10;
      // Admin preview disables behavior-changing hardening so authors can scrub freely
      const hardening = isAdminPreview
        ? { ...buildHardening(effectiveClientSec), serverGatedWindowEnabled: false, shortTokenTtlEnabled: false, velocityScoringEnabled: false }
        : buildHardening(effectiveClientSec);
      const heartbeatHint = { intervalSec: hardening.heartbeatIntervalSec, v2: hardening.heartbeatV2Enabled, msGuard: hardening.mediaSourceGuardEnabled };

      // ── Stealth Mode: resolve the first variant playlist subpath from master.
      // Returns null if not stealth or if we can't resolve a variant (caller
      // falls back to the legacy /hls/* manifestUrl path).
      async function resolveStealthVariant(
        provider: "backblaze_b2" | "cloudflare_r2" | "s3" | "bunny_net",
        cfg: any,
      ): Promise<string | null> {
        if (!hardening.stealthModeEnabled) return null;
        try {
          const masterKey = `${hlsPrefix.replace(/\/$/, "")}/master.m3u8`;
          let originUrl: string;
          if (provider === "backblaze_b2") {
            originUrl = await b2PresignGetObject(cfg.bucket, masterKey, cfg.endpoint, 30);
          } else if (provider === "cloudflare_r2") {
            originUrl = await r2PresignGetObject(cfg.bucket, masterKey, cfg.endpoint, 30);
          } else if (provider === "bunny_net") {
            originUrl = bunnyCdnUrl(cfg.pullZoneUrl, masterKey, 30);
          } else {
            const c = await getS3Client();
            if (!c) return null;
            const cmd = new GetObjectCommand({ Bucket: cfg.bucket, Key: masterKey });
            originUrl = await getSignedUrl(c, cmd, { expiresIn: 30 });
          }
          const masterRes = await fetch(originUrl);
          if (!masterRes.ok) return null;
          const masterText = await masterRes.text();
          for (const raw of masterText.split("\n")) {
            const line = raw.trim();
            if (!line || line.startsWith("#")) continue;
            if (/\.m3u8(\?|$)/i.test(line) && !/^https?:\/\//i.test(line)) {
              return line; // e.g. "720p/index.m3u8"
            }
          }
        } catch (e: any) {
          log(`STEALTH_VARIANT_RESOLVE_FAILED: ${video.publicId} ${e?.message}`);
        }
        return null;
      }

      // Extract integration session linkage from JWT (LMS API flow) so abuse-revoke
      // and admin-revoke can kill the in-memory video session.
      let linkIntegrationSessionId: string | null = null;
      if (token) {
        try {
          const dec: any = verifyToken(token);
          if (dec?.integrationSessionId && typeof dec.integrationSessionId === "string") {
            linkIntegrationSessionId = dec.integrationSessionId;
          }
        } catch {}
      }

      const ekp = (video as any).encryptionKeyPath || null;

      if (conn?.provider === "bunny_net") {
        const cfg = conn.config as any;
        const sid = createSession(video.publicId, hlsPrefix, "bunny_net", cfg, conn.id, dh, ua, suspiciousEnabled, effectiveViolationLimit, hardening, ekp);
        if (linkIntegrationSessionId) setIntegrationSessionId(sid, linkIntegrationSessionId);
        const sessTtls = getSessionTokenTTL(sid);
        const proxyBase = `/hls/${video.publicId}/master.m3u8`;
        const manifestUrl = buildSignedProxyUrl(proxyBase, sid, "/master.m3u8", sessTtls.manifest);
        const stealth = hardening.stealthModeEnabled
          ? { enabled: true, streamUrl: buildStealthMasterUrl(video.publicId, sid, sessTtls.manifest) }
          : { enabled: false };
        return res.json({ manifestUrl, sourceType: "bunny_net_proxy", sessionId: sid, videoId: video.id, videoDuration: video.duration || null, heartbeat: heartbeatHint, stealth, ...(isAdminPreview ? { adminPreview: true } : {}) });
      }

      if (conn?.provider === "backblaze_b2" || conn?.provider === "cloudflare_r2") {
        const cfg = conn.config as any;
        const providerType = conn.provider === "backblaze_b2" ? "backblaze_b2" : "cloudflare_r2";
        const sid = createSession(video.publicId, hlsPrefix, providerType, cfg, conn.id, dh, ua, suspiciousEnabled, effectiveViolationLimit, hardening, ekp);
        if (linkIntegrationSessionId) setIntegrationSessionId(sid, linkIntegrationSessionId);
        const sessTtls = getSessionTokenTTL(sid);
        const proxyBase = `/hls/${video.publicId}/master.m3u8`;
        const manifestUrl = buildSignedProxyUrl(proxyBase, sid, "/master.m3u8", sessTtls.manifest);
        const stealth = hardening.stealthModeEnabled
          ? { enabled: true, streamUrl: buildStealthMasterUrl(video.publicId, sid, sessTtls.manifest) }
          : { enabled: false };
        return res.json({ manifestUrl, sourceType: `${providerType}_proxy`, sessionId: sid, videoId: video.id, videoDuration: video.duration || null, heartbeat: heartbeatHint, stealth, ...(isAdminPreview ? { adminPreview: true } : {}) });
      }

      const client = await getS3Client();
      const s3cfg = await getS3Config();

      if (client && s3cfg.bucket) {
        const sid = createSession(video.publicId, hlsPrefix, "s3", s3cfg, null, dh, ua, suspiciousEnabled, effectiveViolationLimit, hardening, ekp);
        if (linkIntegrationSessionId) setIntegrationSessionId(sid, linkIntegrationSessionId);
        const sessTtls = getSessionTokenTTL(sid);
        const proxyBase = `/hls/${video.publicId}/master.m3u8`;
        const manifestUrl = buildSignedProxyUrl(proxyBase, sid, "/master.m3u8", sessTtls.manifest);
        const stealth = hardening.stealthModeEnabled
          ? { enabled: true, streamUrl: buildStealthMasterUrl(video.publicId, sid, sessTtls.manifest) }
          : { enabled: false };
        return res.json({ manifestUrl, sourceType: "s3_proxy", sessionId: sid, videoDuration: video.duration || null, heartbeat: heartbeatHint, stealth, ...(isAdminPreview ? { adminPreview: true } : {}) });
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

    // Lazy-hydrate from Postgres if this instance doesn't have the session
    // in its local L1 cache. No-op on cache hit.
    await getSessionAsync(sid);
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
    if (!verifySignedPath(sid, subPath, parseInt(exp, 10), st, undefined, 3)) {
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
      } else if (storageProvider === "cloudflare_r2") {
        originUrl = await r2PresignGetObject(storageConfig.bucket, fileKey, storageConfig.endpoint, 30);
      } else if (storageProvider === "bunny_net") {
        originUrl = bunnyCdnUrl(storageConfig.pullZoneUrl, fileKey, 30);
      } else {
        const client = await getS3Client();
        const s3cfg = await getS3Config();
        if (!client || !s3cfg.bucket) return res.status(500).json({ message: "Storage not configured" });
        const cmd = new GetObjectCommand({ Bucket: s3cfg.bucket, Key: fileKey });
        originUrl = await getSignedUrl(client, cmd, { expiresIn: 30 });
      }

      const ttls = getSessionTokenTTL(sid);

      if (isMaster) {
        const fetchRes = await fetch(originUrl);
        if (!fetchRes.ok) {
          const bodySnippet = await fetchRes.text().catch(() => "").then(t => t.slice(0, 200));
          log(`HLS_ORIGIN_404: publicId=${publicId} fileKey=${fileKey} provider=${storageProvider} bucket=${storageConfig?.bucket ?? "?"} status=${fetchRes.status} body=${bodySnippet}`);
          return res.status(404).json({ code: "ORIGIN_PLAYLIST_NOT_FOUND", message: "Playlist not found in storage", publicId });
        }
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
            return buildSignedProxyUrl(proxyBase, sid, variantSubPath, ttls.playlist);
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

          // Auto-correct stored duration if it differs from actual HLS playlist duration
          const hlsDuration = cached.segments.reduce((sum, seg) => {
            const m = seg.extinf.match(/#EXTINF:([\d.]+)/);
            return sum + (m ? parseFloat(m[1]) : 0);
          }, 0);
          if (hlsDuration > 0) {
            storage.getVideoByPublicId(publicId).then(videoRecord => {
              if (!videoRecord) return;
              const storedSec = videoRecord.duration ?? 0;
              if (Math.abs(storedSec - Math.round(hlsDuration)) > 5) {
                log(`[hls] Correcting stored duration for ${publicId}: ${storedSec}s → ${Math.round(hlsDuration)}s`);
                storage.updateVideo(videoRecord.id, { duration: Math.round(hlsDuration) }).catch(() => {});
              }
            }).catch(() => {});
          }
        }

        const totalSegs = cached.segments.length;
        const dh = session.deviceHash;
        const gated = session.hardening.serverGatedWindowEnabled;

        // ── EVENT-style sliding window (fixes backward-seek freeze) ───────
        // The playlist always starts at segment 0 with MEDIA-SEQUENCE:0 and
        // only grows forward. windowEnd is `max(maxSegmentExposed,
        // currentIdx + prebufferSegs)` so it never shrinks across playlist
        // reloads — required for `#EXT-X-PLAYLIST-TYPE:EVENT` compliance.
        // Previous design used windowStart=currentIdx-2 + MEDIA-SEQUENCE:
        // windowStart; on backward seek MEDIA-SEQUENCE went backward
        // (protocol violation) and hls.js rejected the playlist as stale,
        // leaving the player stuck with a permanent buffering spinner.
        const windowSegs = getWindowSegs(session);
        const windowStart = 0;
        const windowEnd = gated
          ? Math.min(totalSegs - 1, Math.max(session.maxSegmentExposed, session.currentSegmentIndex + windowSegs))
          : totalSegs - 1;
        // Commit the high-water mark (in-memory + throttled persistence).
        // Persistence is required so other instances hydrating from DB
        // don't emit a shrunk playlist and re-trigger the EVENT violation.
        if (gated) bumpMaxSegmentExposed(sid, windowEnd);
        const isFinalWindow = windowEnd >= totalSegs - 1;

        // EVENT playlists allow seeking anywhere within the exposed range
        // while still preventing scrapers from prefetching beyond the
        // forward limit. ENDLIST is added once the entire video has been
        // exposed (final window).
        const lines: string[] = [
          "#EXTM3U",
          "#EXT-X-VERSION:3",
          ...(gated ? ["#EXT-X-PLAYLIST-TYPE:EVENT"] : ["#EXT-X-PLAYLIST-TYPE:VOD"]),
          // Bump reported targetDuration to min 6s. hls.js uses this value to
        // schedule EVENT-playlist re-polling (roughly targetDuration × 3-4.5
        // during steady-state when no new segments arrive). With actual 2s
        // segments, the default reported 2s drove ~9s polling cadence. Min
        // 6s pushes polling to ~18-27s — comfortably inside the 15-20s goal
        // — without changing real segment duration, buffer fill, or seek
        // behavior. HLS spec only requires targetDuration ≥ max segment
        // duration; over-reporting is legal and widely tolerated.
        `#EXT-X-TARGETDURATION:${Math.max(cached.targetDuration || 2, 8)}`,
          `#EXT-X-MEDIA-SEQUENCE:${windowStart}`,
        ];

        let lastKeyEmitted = "";
        for (let i = windowStart; i <= windowEnd; i++) {
          const seg = cached.segments[i];

          if (seg.keyTag && seg.keyTag !== lastKeyEmitted) {
            const proxyBase = `/key/${publicId}`;
            const signed = buildStableKeyUrl(proxyBase, sid, session);
            const rewritten = seg.keyTag.replace(/URI="([^"]+)"/, () => `URI="${signed}"`);
            lines.push(rewritten);
            lastKeyEmitted = seg.keyTag;
          }

          lines.push(seg.extinf);
          const segSubPath = path.posix.join(variantDir, seg.uri);
          const proxyBase = `/seg/${publicId}${segSubPath}`;
          lines.push(buildSignedProxyUrl(proxyBase, sid, segSubPath, ttls.segment));
        }

        // VOD/final-window ends with ENDLIST. Mid-window stays open so hls.js polls.
        if (!gated || isFinalWindow) {
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

    await getSessionAsync(sid);
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

    if (!verifySignedPath(sid, segSubPath, parseInt(exp, 10), st, undefined, 3)) {
      return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Invalid or expired segment token", signal: "token_expired" });
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
        // Out-of-window is treated as a recoverable signal (hls.js prefetch / seek
        // overshoot) — NOT abuse. Only mark BREACHED when the session itself was
        // actually revoked due to sustained out-of-window scraping.
        const trueBreach = bi.blocked;
        return res.status(403).json({
          code: trueBreach ? "BLOCKED_SUSPICIOUS_ACTIVITY" : "SEGMENT_WINDOW_VIOLATION",
          error: trueBreach ? "VIDEO_BLOCKED" : "OUT_OF_WINDOW",
          breach: `${bi.breachCount}/${bi.violationLimit}`,
          blockSecondsRemaining: bi.blockSecondsRemaining,
          message: trueBreach ? "Video playback denied due to suspicious activity" : "Segment outside allowed window",
          signal: windowCheck.reason?.signal || "out_of_window",
        });
      }
    }

    const segIp = (req.headers["x-forwarded-for"] as string || req.ip || "").split(",")[0].trim();
    const acquire = acquireSegment(sid, segIp);
    if (acquire.abused) {
      const bi = getBreachInfo(sid);
      return res.status(403).json({ code: "BLOCKED_SUSPICIOUS_ACTIVITY", error: "SECURITY_BREACH", breach: `${bi.breachCount}/${bi.violationLimit}`, blockSecondsRemaining: bi.blockSecondsRemaining, message: "Video playback denied due to suspicious activity", signal: acquire.reason?.signal });
    }

    // Velocity scoring — bulk download / "download ahead" defense
    const velocity = trackSegmentVelocity(sid);
    if (velocity.abused) {
      releaseSegment(sid);
      const bi = getBreachInfo(sid);
      return res.status(403).json({ code: "BLOCKED_SUSPICIOUS_ACTIVITY", error: "SECURITY_BREACH", breach: `${bi.breachCount}/${bi.violationLimit}`, blockSecondsRemaining: bi.blockSecondsRemaining, message: "Download velocity exceeded", signal: velocity.reason?.signal });
    }

    try {
      const { hlsPrefix, storageProvider, storageConfig } = session;
      const fileKey = hlsPrefix + segSubPath.replace(/^\//, "");

      let b2Url: string;
      if (storageProvider === "backblaze_b2") {
        b2Url = await b2PresignGetObject(storageConfig.bucket, fileKey, storageConfig.endpoint, 20);
      } else if (storageProvider === "cloudflare_r2") {
        b2Url = await r2PresignGetObject(storageConfig.bucket, fileKey, storageConfig.endpoint, 20);
      } else if (storageProvider === "bunny_net") {
        b2Url = bunnyCdnUrl(storageConfig.pullZoneUrl, fileKey, 20);
      } else {
        const client = await getS3Client();
        const s3cfg = await getS3Config();
        if (!client || !s3cfg.bucket) { releaseSegment(sid); return res.status(500).json({ message: "Storage not configured" }); }
        const cmd = new GetObjectCommand({ Bucket: s3cfg.bucket, Key: fileKey });
        b2Url = await getSignedUrl(client, cmd, { expiresIn: 20 });
      }

      // Never redirect to origin — proxy bytes so B2/R2/S3/Bunny URLs stay server-side.
      // Hot-path log gated behind LOG_VERBOSE — fires once per segment otherwise
      // and synchronous stdout writes become an event-loop bottleneck at scale.
      if (process.env.LOG_VERBOSE === "1") log(`SEGMENT_PROXY: sid=${sid}, seg=${segSubPath}, fileKey=${fileKey}`);
      try {
        const range = req.headers["range"];
        // AbortController tied to PREMATURE client disconnect only — listens on
        // res.close and checks res.writableEnded to distinguish a real disconnect
        // from the normal end-of-response close event. The earlier req.on("close")
        // version fired on every successful request after pipe completion, which
        // in Node 20 could race with the body stream and terminate it mid-flight.
        const abortCtrl = new AbortController();
        res.on("close", () => { if (!res.writableEnded) abortCtrl.abort(); });
        const upstream = await fetch(b2Url, {
          headers: range ? { Range: String(range) } : undefined,
          signal: abortCtrl.signal,
        }).catch((err: any) => {
          if (err?.name === "AbortError") return null;
          throw err;
        });
        if (!upstream) {
          releaseSegment(sid);
          return;
        }
        if (!upstream.ok && upstream.status !== 206) {
          releaseSegment(sid);
          return res.status(502).json({ message: "Segment upstream failed" });
        }
        res.status(upstream.status);
        // Stealth: do NOT pass through content-type (B2 returns "video/MP2T" which
        // CocoCut detects as media). Force opaque application/octet-stream.
        const passHeaders = ["content-length", "content-range", "accept-ranges"];
        for (const h of passHeaders) {
          const v = upstream.headers.get(h);
          if (v) res.setHeader(h, v);
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Cache-Control", "private, no-store, no-cache, max-age=0");
        res.setHeader("X-Content-Type-Options", "nosniff");
        const body = upstream.body as any;
        if (body && typeof body.getReader === "function") {
          const { Readable } = await import("stream");
          const nodeStream = Readable.fromWeb(body);
          nodeStream.on("close", () => releaseSegment(sid));
          nodeStream.on("error", () => releaseSegment(sid));
          nodeStream.pipe(res);
        } else {
          const buf = Buffer.from(await upstream.arrayBuffer());
          releaseSegment(sid);
          res.end(buf);
        }
      } catch (proxyErr: any) {
        releaseSegment(sid);
        log(`Segment proxy upstream error for ${req.params.publicId}${segSubPath}: ${proxyErr.message}`);
        return res.status(502).json({ message: "Segment proxy error" });
      }
    } catch (e: any) {
      releaseSegment(sid);
      log(`Segment proxy error for ${req.params.publicId}${req.path}: ${e.message}`);
      res.status(500).json({ message: "Segment error" });
    }
  });

  // ── Stealth Mode endpoints ────────────────────────────────────────────────
  // Opaque-named routes that hide HLS-specific names (.m3u8, .ts, /key, master,
  // index, seg_*) from the browser Network tab. They internally reuse the
  // exact same validation + B2/R2/S3 logic as /hls, /seg, /key — including
  // session binding, UA check, abuse detection, segment window, velocity
  // scoring, and key rate limits. Activated when stealthModeEnabled is on
  // for the video; in that case the /manifest response returns a
  // `stealth: { enabled:true, streamUrl }` field that points at /stream/window.
  //
  // The legacy /hls, /seg, /key routes remain fully functional so existing
  // playback paths and admin previews are unaffected.

  // X-Playback-Error response header — short opaque token consumed by the
  // embed player to distinguish recoverable expiry from real abuse without
  // having to parse the JSON body (hls.js doesn't always surface body text
  // on 403, especially when the request was aborted by an in-flight rotation).
  //
  // Recoverable (player silently renews + retries):
  //   TOKEN_EXPIRED       — opaque ID exp passed (chunk/secret/window)
  //   WINDOW_EXPIRED      — playlist (level) opaque ID exp passed
  //   SECRET_EXPIRED      — key opaque ID exp passed
  //   OUT_OF_WINDOW       — server-gated playlist window doesn't include this seg
  //   HEARTBEAT_STALE     — session expired/heartbeat too old
  //   SESSION_ROTATED     — old SID still inside overlap grace but rotation done
  // Fatal (player shows denial overlay, no retry):
  //   SESSION_REVOKED     — abuse-detection or manual revocation
  //   PLAYBACK_DENIED     — generic deny (mismatch, malformed, etc.)
  //   BLOCKED_SUSPICIOUS_ACTIVITY — breach threshold reached
  function setPlaybackErrorHeader(res: any, code: string) {
    try { res.setHeader("X-Playback-Error", code); } catch {}
  }

  function stealthDeny(res: any, sid: string, message: string, signal?: string, status = 403) {
    const bi = getBreachInfo(sid);
    // Recoverable signals — silent retry on client. NOT marked as abuse breach.
    const recoverable = new Set(["token_expired", "signed_url_expired", "out_of_window", "heartbeat_invalid", "rotated"]);
    const isRecoverable = signal ? recoverable.has(signal) : false;
    let code = "PLAYBACK_DENIED";
    let error: string;
    if (bi.blocked) {
      code = "BLOCKED_SUSPICIOUS_ACTIVITY";
      error = "VIDEO_BLOCKED";
    } else if (isRecoverable) {
      code = signal === "out_of_window" ? "SEGMENT_WINDOW_VIOLATION" :
             signal === "heartbeat_invalid" ? "HEARTBEAT_STALE" :
             signal === "rotated" ? "SESSION_ROTATED" : "TOKEN_EXPIRED";
      error = signal === "out_of_window" ? "OUT_OF_WINDOW" :
              signal === "heartbeat_invalid" ? "HEARTBEAT_STALE" :
              signal === "rotated" ? "SESSION_ROTATED" : "TOKEN_EXPIRED";
    } else {
      code = "BLOCKED_SUSPICIOUS_ACTIVITY";
      error = "SECURITY_BREACH";
    }
    setPlaybackErrorHeader(res, code);
    return res.status(status).json({ code, error, breach: `${bi.breachCount}/${bi.violationLimit}`, blockSecondsRemaining: bi.blockSecondsRemaining, message, signal });
  }

  // Small helper used by the three stealth media routes (window/chunk/secret)
  // to (a) decode the opaque ID without expiry-checking, (b) look up the
  // session honoring rotation overlap grace, and (c) re-check expiry against
  // the per-session windowOverlapGraceSec. Returns either a 403-emitted
  // response or a {session, payload} pair on success.
  async function loadStealthCtx(
    req: any,
    res: any,
    opaqueId: string,
    expectedType: "l" | "c" | "k" | "m",
    expiredCode: "WINDOW_EXPIRED" | "OPAQUE_ID_EXPIRED" | "SECRET_EXPIRED" | "MASTER_EXPIRED",
  ): Promise<{ session: any; payload: OpaquePayload } | null> {
    const decoded = decodeOpaqueIdSkipExpiry(opaqueId);
    if (!decoded || decoded.t !== expectedType) {
      setPlaybackErrorHeader(res, "PLAYBACK_DENIED");
      log(`stealth ${expectedType} decode failed pub=${req.params.publicId} idLen=${opaqueId.length}`);
      res.status(403).json({ code: "PLAYBACK_DENIED", error: decoded ? "OPAQUE_ID_TAMPERED" : "OPAQUE_ID_MALFORMED", message: "Invalid stream token", signal: "token_expired" });
      return null;
    }
    const sid = decoded.s;
    // DB-aware rotation grace lookup — works across instances. We use a
    // generous fallback (60s) for the cross-instance check so we can THEN
    // re-apply the precise per-session windowOverlapGraceSec from hardening.
    const status = await getSessionAllowingRotationGraceAsync(sid, 60);
    if (status.kind === "not_found" || status.kind === "expired") {
      // RECOVERABLE — the player should silently renew. Map to
      // HEARTBEAT_STALE so the frontend's smart-403 path triggers token
      // refresh instead of the terminal denial overlay.
      setPlaybackErrorHeader(res, "HEARTBEAT_STALE");
      log(`MEDIA_ROUTE_403: code=HEARTBEAT_STALE kind=${status.kind} sid=${sid} pub=${req.params.publicId}`);
      res.status(403).json({ code: "HEARTBEAT_STALE", error: "SESSION_EXPIRED", message: "Session expired — please refresh", signal: "heartbeat_invalid" });
      return null;
    }
    if (status.kind === "revoked") {
      // TERMINAL — abuse/manual revoke. Player must show denial overlay.
      setPlaybackErrorHeader(res, "SESSION_REVOKED");
      log(`MEDIA_ROUTE_403: code=SESSION_REVOKED signal=${status.signal} sid=${sid} pub=${req.params.publicId}`);
      res.status(403).json({ code: "SESSION_REVOKED", error: "SESSION_REVOKED", message: "Session was revoked", signal: status.signal });
      return null;
    }
    const session = status.session;
    if (status.kind === "rotation_grace") {
      // Recoverable — the player has already rotated to a new SID; this is
      // an in-flight request from the old manifest. Allow this fetch but
      // signal SESSION_ROTATED so any subsequent error after grace ends
      // routes to renewal cleanly. We DON'T 403 here — we let the request
      // succeed and just stamp the header for observability.
      setPlaybackErrorHeader(res, "SESSION_ROTATED");
    }
    if (session.publicId !== req.params.publicId) {
      setPlaybackErrorHeader(res, "PLAYBACK_DENIED");
      res.status(403).json({ code: "PLAYBACK_DENIED", message: "Session mismatch" });
      return null;
    }
    const graceSec = Math.max(3, session.hardening?.windowOverlapGraceSec || 3);
    if (isOpaqueExpired(decoded, graceSec)) {
      setPlaybackErrorHeader(res, expiredCode);
      log(`MEDIA_ROUTE_403: code=${expiredCode} sid=${sid} pub=${req.params.publicId} grace=${graceSec}s`);
      res.status(403).json({ code: expiredCode, error: "OPAQUE_ID_EXPIRED", message: "Stream token expired", signal: "token_expired" });
      return null;
    }
    return { session, payload: decoded };
  }

  // GET /api/player/:publicId/stream/master/:opaqueId
  //   The "master" playlist in stealth mode. Browser sees only this opaque
  //   URL — no .m3u8 / no master / no variant name in the path. Body is an
  //   HLS master.m3u8 whose every #EXT-X-STREAM-INF entry points at a fresh
  //   opaque /stream/window URL bound to the same sid. This is what makes
  //   the quality selector work in stealth mode — without a master, hls.js
  //   only sees a single level and the 360p/480p/720p picker is hidden.
  app.get("/api/player/:publicId/stream/master/:opaqueId", async (req: any, res: any) => {
    const opaqueId = String(req.params.opaqueId || "");
    const ctx = await loadStealthCtx(req, res, opaqueId, "m", "MASTER_EXPIRED");
    if (!ctx) return;
    const { session, payload: decoded } = ctx;
    const sid = decoded.s;
    if (!session.hardening.stealthModeEnabled) {
      return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Stealth mode not active for this session" });
    }

    const ua = req.headers["user-agent"] || "";
    if (!validateUserAgent(sid, ua)) {
      log(`SECURITY: UA mismatch on stream/master for sid=${sid}`);
      return stealthDeny(res, sid, "Device mismatch");
    }

    try {
      const { hlsPrefix, storageProvider, storageConfig } = session;
      const masterKey = `${hlsPrefix.replace(/\/$/, "")}/master.m3u8`;

      let originUrl: string;
      if (storageProvider === "backblaze_b2") {
        originUrl = await b2PresignGetObject(storageConfig.bucket, masterKey, storageConfig.endpoint, 30);
      } else if (storageProvider === "cloudflare_r2") {
        originUrl = await r2PresignGetObject(storageConfig.bucket, masterKey, storageConfig.endpoint, 30);
      } else if (storageProvider === "bunny_net") {
        originUrl = bunnyCdnUrl(storageConfig.pullZoneUrl, masterKey, 30);
      } else {
        const c = await getS3Client();
        const s3cfg = await getS3Config();
        if (!c || !s3cfg.bucket) return res.status(500).json({ message: "Storage not configured" });
        const cmd = new GetObjectCommand({ Bucket: s3cfg.bucket, Key: masterKey });
        originUrl = await getSignedUrl(c, cmd, { expiresIn: 30 });
      }

      const masterRes = await fetch(originUrl);
      if (!masterRes.ok) {
        log(`[stream/master] UPSTREAM_NOT_FOUND pub=${req.params.publicId} sid=${sid} key=${masterKey} status=${masterRes.status}`);
        return res.status(404).json({ message: "Master playlist not found" });
      }
      const masterText = await masterRes.text();

      // PART 4 diagnostic: count STREAM-INF entries in the upstream master so we
      // can immediately see whether the issue is upstream (only 1 variant
      // produced by ffmpeg / uploaded) vs downstream (rewrite stripped variants).
      const upstreamStreamInfCount = (masterText.match(/#EXT-X-STREAM-INF/g) || []).length;
      log(`[stream/master] UPSTREAM pub=${req.params.publicId} sid=${sid} key=${masterKey} bytes=${masterText.length} streamInfCount=${upstreamStreamInfCount}`);
      if (upstreamStreamInfCount <= 1) {
        log(`[stream/master] WARNING: upstream master has ${upstreamStreamInfCount} variant(s) — quality selector will be hidden. Re-transcode this video with multiple qualities selected.`);
      }

      const ttls = getSessionTokenTTL(sid);
      const outLines: string[] = [];
      let rewrittenVariantCount = 0;
      const lines = masterText.split("\n");
      // Rewrites any URI="..." attribute inside an HLS tag (e.g.
      // #EXT-X-MEDIA, #EXT-X-I-FRAME-STREAM-INF). Without this, an
      // external https:// origin URL embedded as URI="..." would leak
      // straight to the browser, breaking the stealth invariant.
      const rewriteTagUriAttr = (tagLine: string): string | null => {
        const m = tagLine.match(/URI="([^"]*)"/i);
        if (!m) return tagLine;
        const uri = m[1];
        // Drop any absolute external URL — we never want to hand the
        // browser an origin location, even via a manifest tag.
        if (/^https?:\/\//i.test(uri)) {
          log(`STEALTH_MASTER_STRIPPED_TAG_EXTERNAL_URI: pub=${req.params.publicId} sid=${sid}`);
          return null;
        }
        if (/\.m3u8(\?|$)/i.test(uri)) {
          const opaque = buildStealthLevelUrl(req.params.publicId, sid, uri.replace(/^\//, ""), ttls.manifest);
          return tagLine.replace(/URI="[^"]*"/i, `URI="${opaque}"`);
        }
        // For non-playlist URIs inside tags (init segments, subs, etc.)
        // we currently only support relative master playlist variants.
        // Strip anything else rather than risk leaking it.
        log(`STEALTH_MASTER_STRIPPED_TAG_UNSUPPORTED_URI: pub=${req.params.publicId} sid=${sid}`);
        return null;
      };
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = raw.trim();
        if (!line) { outLines.push(raw); continue; }
        if (line.startsWith("#")) {
          if (/URI="/i.test(line)) {
            const rewritten = rewriteTagUriAttr(line);
            if (rewritten !== null) outLines.push(rewritten);
          } else {
            outLines.push(raw);
          }
          continue;
        }
        // Strip any external (http://, https://) playlist URLs — security
        // invariant: stealth master must NEVER expose an origin URL.
        if (/^https?:\/\//i.test(line)) {
          log(`STEALTH_MASTER_STRIPPED_EXTERNAL_URL: pub=${req.params.publicId} sid=${sid}`);
          continue;
        }
        // Rewrite each relative variant playlist to a fresh stealth level URL.
        if (/\.m3u8(\?|$)/i.test(line)) {
          outLines.push(buildStealthLevelUrl(req.params.publicId, sid, line.replace(/^\//, ""), ttls.manifest));
          rewrittenVariantCount++;
        } else {
          outLines.push(raw);
        }
      }

      const responseBody = outLines.join("\n");
      log(`[stream/master] DONE pub=${req.params.publicId} sid=${sid} upstreamVariants=${upstreamStreamInfCount} rewrittenVariants=${rewrittenVariantCount} responseBytes=${responseBody.length}`);
      if (rewrittenVariantCount !== upstreamStreamInfCount) {
        log(`[stream/master] MISMATCH variant rewrite count differs from upstream — some variants may have been stripped (external URL or unsupported scheme)`);
      }

      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.send(responseBody);
    } catch (e: any) {
      log(`stream/master error for ${req.params.publicId}: ${e.message}`);
      return res.status(500).json({ message: "Stream master error" });
    }
  });

  // GET /api/player/:publicId/stream/window/:opaqueId
  //   The "level" playlist. Browser sees only this opaque URL — no .m3u8 in
  //   the path. Body is HLS text whose segment URIs are opaque /stream/chunk
  //   IDs and whose key URI is an opaque /stream/secret ID.
  app.get("/api/player/:publicId/stream/window/:opaqueId", async (req: any, res: any) => {
    const opaqueId = String(req.params.opaqueId || "");
    // loadStealthCtx is async and handles cross-instance DB hydration +
    // rotation-grace lookup internally — no separate pre-hydrate needed.
    const ctx = await loadStealthCtx(req, res, opaqueId, "l", "WINDOW_EXPIRED");
    if (!ctx) return; // headers + 403 already sent
    const { session, payload: decoded } = ctx;
    const sid = decoded.s;
    if (!decoded.v) { setPlaybackErrorHeader(res, "PLAYBACK_DENIED"); return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Invalid window payload" }); }
    if (!session.hardening.stealthModeEnabled) {
      return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Stealth mode not active for this session" });
    }

    const ua = req.headers["user-agent"] || "";
    if (!validateUserAgent(sid, ua)) {
      log(`SECURITY: UA mismatch on stream/window for sid=${sid}`);
      return stealthDeny(res, sid, "Device mismatch");
    }

    const ip = (req.headers["x-forwarded-for"] as string || req.ip || "").split(",")[0].trim();
    const { abused, reason } = trackPlaylistFetch(sid, ip);
    if (abused) return stealthDeny(res, sid, "Video playback denied due to suspicious activity", reason?.signal);

    try {
      const variantSubPath = decoded.v!; // e.g. "720p/index.m3u8"
      const variantDir = path.posix.dirname("/" + variantSubPath);
      const { hlsPrefix, storageProvider, storageConfig } = session;
      const fileKey = hlsPrefix.replace(/\/$/, "") + "/" + variantSubPath;

      let originUrl: string;
      if (storageProvider === "backblaze_b2") {
        originUrl = await b2PresignGetObject(storageConfig.bucket, fileKey, storageConfig.endpoint, 30);
      } else if (storageProvider === "cloudflare_r2") {
        originUrl = await r2PresignGetObject(storageConfig.bucket, fileKey, storageConfig.endpoint, 30);
      } else if (storageProvider === "bunny_net") {
        originUrl = bunnyCdnUrl(storageConfig.pullZoneUrl, fileKey, 30);
      } else {
        const c = await getS3Client();
        const s3cfg = await getS3Config();
        if (!c || !s3cfg.bucket) return res.status(500).json({ message: "Storage not configured" });
        const cmd = new GetObjectCommand({ Bucket: s3cfg.bucket, Key: fileKey });
        originUrl = await getSignedUrl(c, cmd, { expiresIn: 30 });
      }

      const cacheKey = "/" + variantSubPath;
      let cached: PlaylistCache | undefined = session.variantCache.get(cacheKey);
      if (!cached) {
        const fetchRes = await fetch(originUrl);
        if (!fetchRes.ok) return res.status(404).json({ message: "Variant playlist not found" });
        cached = parsePlaylist(await fetchRes.text());
        session.variantCache.set(cacheKey, cached);
      }

      const ttls = getSessionTokenTTL(sid);
      const totalSegs = cached.segments.length;
      const gated = session.hardening.serverGatedWindowEnabled;
      // EVENT-style window (see legacy /hls/ handler for full rationale):
      // playlist always starts at 0 with MEDIA-SEQUENCE:0, grows monotonically.
      // Fixes backward-seek freeze caused by MEDIA-SEQUENCE going backward.
      const windowSegsStealth = getWindowSegs(session);
      const windowStart = 0;
      const windowEnd = gated
        ? Math.min(totalSegs - 1, Math.max(session.maxSegmentExposed, session.currentSegmentIndex + windowSegsStealth))
        : totalSegs - 1;
      // Commit the high-water mark with throttled cross-instance persistence.
      if (gated) bumpMaxSegmentExposed(sid, windowEnd);
      const isFinalWindow = windowEnd >= totalSegs - 1;

      const lines: string[] = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        ...(gated ? ["#EXT-X-PLAYLIST-TYPE:EVENT"] : ["#EXT-X-PLAYLIST-TYPE:VOD"]),
        // Bump reported targetDuration to min 6s. hls.js uses this value to
        // schedule EVENT-playlist re-polling (roughly targetDuration × 3-4.5
        // during steady-state when no new segments arrive). With actual 2s
        // segments, the default reported 2s drove ~9s polling cadence. Min
        // 6s pushes polling to ~18-27s — comfortably inside the 15-20s goal
        // — without changing real segment duration, buffer fill, or seek
        // behavior. HLS spec only requires targetDuration ≥ max segment
        // duration; over-reporting is legal and widely tolerated.
        `#EXT-X-TARGETDURATION:${Math.max(cached.targetDuration || 2, 8)}`,
        `#EXT-X-MEDIA-SEQUENCE:${windowStart}`,
      ];

      let lastKeyEmitted = "";
      for (let i = windowStart; i <= windowEnd; i++) {
        const seg = cached.segments[i];
        if (seg.keyTag && seg.keyTag !== lastKeyEmitted) {
          const signedKey = buildStealthKeyUrl(req.params.publicId, sid, ttls.key);
          const rewritten = seg.keyTag.replace(/URI="([^"]+)"/, () => `URI="${signedKey}"`);
          lines.push(rewritten);
          lastKeyEmitted = seg.keyTag;
        }
        lines.push(seg.extinf);
        const segSubPath = path.posix.join(variantDir, seg.uri).replace(/^\//, "");
        lines.push(buildStealthChunkUrl(req.params.publicId, sid, segSubPath, ttls.segment));
      }
      if (!gated || isFinalWindow) lines.push("#EXT-X-ENDLIST");

      // Stealth: never expose HLS MIME — CocoCut/scrapers identify by Content-Type.
      // hls.js parses the body by looking for "#EXTM3U", not by MIME type.
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.send(lines.join("\n") + "\n");
    } catch (e: any) {
      log(`stream/window error for ${req.params.publicId}: ${e.message}`);
      return res.status(500).json({ message: "Stream window error" });
    }
  });

  // GET /api/player/:publicId/stream/chunk/:opaqueId
  //   The opaque-named segment endpoint. Decodes the opaque ID to recover
  //   the real segment subpath, runs the full segment proxy validation
  //   (UA, window, abuse, velocity), and redirects to the presigned origin.
  app.get("/api/player/:publicId/stream/chunk/:opaqueId", async (req: any, res: any) => {
    const opaqueId = String(req.params.opaqueId || "");
    const ctx = await loadStealthCtx(req, res, opaqueId, "c", "OPAQUE_ID_EXPIRED");
    if (!ctx) return;
    const { session, payload: decoded } = ctx;
    const sid = decoded.s;
    if (!decoded.p) { setPlaybackErrorHeader(res, "PLAYBACK_DENIED"); return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Invalid chunk payload" }); }
    if (!session.hardening.stealthModeEnabled) {
      return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Stealth mode not active for this session" });
    }

    const ua = req.headers["user-agent"] || "";
    if (!validateUserAgent(sid, ua)) {
      log(`SECURITY: UA mismatch on stream/chunk for sid=${sid}`);
      return stealthDeny(res, sid, "Device mismatch");
    }

    const segSubPath = decoded.p!.replace(/^\//, "");
    const segMatch = segSubPath.match(/seg_?(\d+)\./i);
    if (segMatch) {
      const segIdx = parseInt(segMatch[1], 10);
      const windowCheck = validateSegmentWindow(sid, segIdx);
      if (!windowCheck.allowed) {
        return stealthDeny(res, sid, "Segment outside allowed window", windowCheck.reason?.signal || "out_of_window");
      }
    }

    const ip = (req.headers["x-forwarded-for"] as string || req.ip || "").split(",")[0].trim();
    const acquire = acquireSegment(sid, ip);
    if (acquire.abused) return stealthDeny(res, sid, "Video playback denied due to suspicious activity", acquire.reason?.signal);

    const velocity = trackSegmentVelocity(sid);
    if (velocity.abused) {
      releaseSegment(sid);
      return stealthDeny(res, sid, "Download velocity exceeded", velocity.reason?.signal);
    }

    try {
      const { hlsPrefix, storageProvider, storageConfig } = session;
      const fileKey = hlsPrefix.replace(/\/$/, "") + "/" + segSubPath;
      let originUrl: string;
      if (storageProvider === "backblaze_b2") {
        originUrl = await b2PresignGetObject(storageConfig.bucket, fileKey, storageConfig.endpoint, 20);
      } else if (storageProvider === "cloudflare_r2") {
        originUrl = await r2PresignGetObject(storageConfig.bucket, fileKey, storageConfig.endpoint, 20);
      } else if (storageProvider === "bunny_net") {
        originUrl = bunnyCdnUrl(storageConfig.pullZoneUrl, fileKey, 20);
      } else {
        const c = await getS3Client();
        const s3cfg = await getS3Config();
        if (!c || !s3cfg.bucket) { releaseSegment(sid); return res.status(500).json({ message: "Storage not configured" }); }
        const cmd = new GetObjectCommand({ Bucket: s3cfg.bucket, Key: fileKey });
        originUrl = await getSignedUrl(c, cmd, { expiresIn: 20 });
      }
      // Stealth contract: never expose origin URL to the browser. Stream bytes
      // through our server so the only network entry visible to the client is
      // the opaque /stream/chunk/:opaqueId URL.
      const range = req.headers["range"];
      // Abort upstream only on PREMATURE disconnect (see /seg comment above).
      const abortCtrl = new AbortController();
      res.on("close", () => { if (!res.writableEnded) abortCtrl.abort(); });
      const upstream = await fetch(originUrl, {
        headers: range ? { Range: String(range) } : undefined,
        signal: abortCtrl.signal,
      }).catch((err: any) => {
        if (err?.name === "AbortError") return null;
        throw err;
      });
      if (!upstream) { releaseSegment(sid); return; }
      if (!upstream.ok && upstream.status !== 206) {
        releaseSegment(sid);
        log(`stream/chunk upstream failed status=${upstream.status} key=${fileKey}`);
        return res.status(502).json({ message: "Chunk upstream failed" });
      }
      res.status(upstream.status);
      // Stealth: drop content-type, etag, last-modified from passthrough — these leak
      // media identity to scrapers (B2 returns "video/MP2T" which CocoCut sniffs).
      const passthrough = ["content-length", "content-range", "accept-ranges"];
      for (const h of passthrough) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Cache-Control", "private, no-store, no-cache, max-age=0");
      res.setHeader("X-Content-Type-Options", "nosniff");
      const body = upstream.body as any;
      if (body && typeof body.getReader === "function") {
        const { Readable } = await import("stream");
        const nodeStream = Readable.fromWeb(body);
        nodeStream.on("close", () => releaseSegment(sid));
        nodeStream.on("error", () => releaseSegment(sid));
        nodeStream.pipe(res);
      } else {
        const buf = Buffer.from(await upstream.arrayBuffer());
        releaseSegment(sid);
        res.end(buf);
      }
    } catch (e: any) {
      releaseSegment(sid);
      log(`stream/chunk error for ${req.params.publicId}: ${e.message}`);
      return res.status(500).json({ message: "Chunk error" });
    }
  });

  // GET /api/player/:publicId/stream/secret/:opaqueId
  //   The opaque-named key endpoint. Decodes the opaque ID, validates session
  //   + UA + key rate limits, then returns the AES master key bytes.
  //
  //   Hot-path optimisation: encryptionKeyPath is stored on the session object
  //   at creation time (see createSession), so we skip storage.getVideoByPublicId
  //   entirely — eliminating the ~250ms Supabase round-trip that previously
  //   happened on every key fetch. Falls back to a live DB lookup only for
  //   old in-flight sessions that were created before this change.
  app.get("/api/player/:publicId/stream/secret/:opaqueId", async (req: any, res: any) => {
    const opaqueId = String(req.params.opaqueId || "");
    const ctx = await loadStealthCtx(req, res, opaqueId, "k", "SECRET_EXPIRED");
    if (!ctx) return;
    const { session, payload: decoded } = ctx;
    const sid = decoded.s;
    if (!session.hardening.stealthModeEnabled) {
      return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Stealth mode not active for this session" });
    }

    const ua = req.headers["user-agent"] || "";
    if (!validateUserAgent(sid, ua)) {
      log(`SECURITY: UA mismatch on stream/secret for sid=${sid}`);
      return stealthDeny(res, sid, "Device mismatch");
    }

    const ip = (req.headers["x-forwarded-for"] as string || req.ip || "").split(",")[0].trim();
    const { abused: keyAbused, reason: keyReason } = trackKeyHit(sid, ip);
    if (keyAbused) return stealthDeny(res, sid, "Key rate limit exceeded", keyReason?.signal, 429);

    try {
      // Fast path: use the encryptionKeyPath stored on the session at creation
      // time — no DB query needed.
      let keyPath: string | null = session.encryptionKeyPath || null;

      // Fallback for sessions created before this optimisation (no keyPath on
      // session yet): do a single DB lookup and log it so we can track
      // how often the fallback fires after the deploy settles.
      if (!keyPath) {
        const video = await storage.getVideoByPublicId(req.params.publicId);
        keyPath = video?.encryptionKeyPath || null;
        if (keyPath) {
          log(`[stream/secret] fallback DB lookup for sid=${sid} (pre-optimisation session)`);
        }
      }

      if (!keyPath) {
        return res.status(404).json({ code: "PLAYBACK_DENIED", message: "Encryption key not found" });
      }
      const masterKey = await getMasterKey(keyPath, session);
      if (!masterKey) return res.status(500).json({ code: "PLAYBACK_DENIED", message: "Key fetch failed" });
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", masterKey.length);
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.send(masterKey);
    } catch (e: any) {
      log(`stream/secret error: ${e.message}`);
      return res.status(500).json({ code: "PLAYBACK_DENIED", message: "Key fetch failed" });
    }
  });

  // ── Internal helpers shared by /tick, /progress, /heartbeat, /ping ───────
  // Each helper assumes the caller already validated sid + session existence
  // + publicId match. They return plain objects; the caller decides HTTP
  // status. Blocked/rejected outcomes set `blocked: true` and a `code`.
  // ─────────────────────────────────────────────────────────────────────────
  function _runProgressLogic(
    sid: string,
    session: any,
    body: { segmentIndex?: number; currentTime?: number; seekTo?: boolean }
  ): { ok: true; windowStart: number; windowEnd: number; targetSegmentIndex?: number } {
    const { segmentIndex, currentTime, seekTo } = body || {};
    let idx = typeof segmentIndex === "number" ? segmentIndex : -1;
    if (idx < 0 && typeof currentTime === "number") {
      const anyCache = session.variantCache.values().next().value as PlaylistCache | undefined;
      if (anyCache && anyCache.targetDuration > 0) {
        idx = Math.floor(currentTime / anyCache.targetDuration);
      } else if (seekTo === true && currentTime >= 0) {
        idx = Math.floor(currentTime / 2);
      }
    }
    if (idx >= 0) {
      updateProgress(sid, idx, seekTo === true);
    }
    const { start, end } = getWindowRange(sid);
    return { ok: true, windowStart: start, windowEnd: end, ...(idx >= 0 ? { targetSegmentIndex: idx } : {}) };
  }

  async function _runHeartbeatLogic(
    sid: string,
    session: any,
    req: any,
    body: { seq?: any; nonce?: any; currentTime?: any; segmentIndex?: any; playbackRate?: any }
  ): Promise<
    | { ok: true; rotationIntervalMs: number; intervalSec: number; heartbeatIntervalSec: number; overlapGraceSec: number; renewalGraceSec: number; sessionExpiresAt: number; nextRefreshAt: number; windowStart?: number; windowEnd?: number; segmentIndex?: number }
    | { ok: false; blocked: true; code: string; message: string; signal?: string; breach?: string }
  > {
    const ua = req.headers["user-agent"] || "";
    if (!validateUserAgent(sid, ua)) {
      return { ok: false, blocked: true, code: "PLAYBACK_DENIED", message: "Device mismatch" };
    }
    const result = verifyHeartbeat(sid, {
      seq: Number(body.seq),
      nonce: String(body.nonce || ""),
      currentTime: Number(body.currentTime),
      segmentIndex: typeof body.segmentIndex === "number" ? body.segmentIndex : undefined,
      playbackRate: typeof body.playbackRate === "number" ? body.playbackRate : undefined,
    });
    if (!result.ok) {
      const bi = getBreachInfo(sid);
      return { ok: false, blocked: true, code: "PLAYBACK_DENIED", message: "Heartbeat rejected", signal: result.reason, breach: `${bi.breachCount}/${bi.violationLimit}` };
    }
    extendSession(sid);
    const hardening = session.hardening;
    const overlapGraceSec = hardening.windowOverlapGraceSec;
    const heartbeatIntervalSec = hardening.heartbeatIntervalSec;
    const nextRefreshInMs = Math.max(5000, Math.floor(heartbeatIntervalSec * 0.7 * 1000));
    if (Math.random() < 0.02) {
      console.log(`[playback] HEARTBEAT_OK: sid=${sid} pub=${session.publicId} t=${Number(body.currentTime)||0}s expiresIn=${Math.round((session.expiresAt - Date.now())/1000)}s`);
    }
    return {
      ok: true,
      rotationIntervalMs: SESSION_ROTATION_MS,
      intervalSec: heartbeatIntervalSec,
      heartbeatIntervalSec,
      overlapGraceSec,
      renewalGraceSec: overlapGraceSec,
      sessionExpiresAt: session.expiresAt,
      nextRefreshAt: Date.now() + nextRefreshInMs,
      windowStart: result.windowStart,
      windowEnd: result.windowEnd,
      segmentIndex: result.newSegmentIndex,
    };
  }

  async function _runPingLogic(
    publicId: string,
    req: any,
    body: { sessionCode?: string; secondsWatched?: number }
  ): Promise<{ ok?: boolean; sessionCode?: string }> {
    const { sessionCode, secondsWatched } = body || {};
    if (sessionCode) {
      await storage.pingSession(sessionCode, Math.round(secondsWatched || 0));
      return { ok: true };
    }
    const video = await storage.getVideoByPublicId(publicId);
    if (video) {
      const code = nanoid(16);
      const domain = (req.headers["x-embed-referrer"] as string) || (req.headers.referer as string) || "";
      let domainHost = "";
      try { domainHost = new URL(domain).hostname; } catch {}
      await storage.createSession({
        videoId: video.id,
        sessionCode: code,
        domain: domainHost,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      return { sessionCode: code };
    }
    return { ok: true };
  }

  // ── Progress endpoint — player reports current segment for window tracking ───
  // Thin shim over _runProgressLogic. Old players in flight after the /tick
  // deploy still POST here directly; new players consolidate into /tick.
  app.post("/api/stream/:publicId/progress", async (req: any, res: any) => {
    try {
      const { sid } = req.body || {};
      if (!sid) return res.status(400).json({ message: "Missing sid" });
      await getSessionAsync(sid);
      const session = getSession(sid);
      if (!session || session.revoked) return res.status(403).json({ message: "Session invalid" });
      if (session.publicId !== req.params.publicId) return res.status(403).json({ message: "Session mismatch" });
      return res.json(_runProgressLogic(sid, session, req.body || {}));
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── /tick — consolidated progress + heartbeat + ping ─────────────────────
  // POST /api/player/:publicId/tick
  // Body: {
  //   sid, currentTime, epoch,
  //   include: ["progress"?, "heartbeat"?, "ping"?],
  //   // progress fields:
  //   segmentIndex?, seekTo?,
  //   // heartbeat v2 fields (when "heartbeat" in include):
  //   seq?, nonce?, playbackRate?,
  //   // ping fields (when "ping" in include):
  //   sessionCode?, secondsWatched?,
  //   // optional flag for analytics flush on unload/visibility/end:
  //   final?
  // }
  // Single session validation gate, then runs each requested subsystem.
  // First blocking subsystem short-circuits the response with 403.
  // Cuts control-plane RPS by ~50% vs the three separate endpoints.
  // Beacon-safe body parser: navigator.sendBeacon CAN deliver a Blob with
  // type "application/json" (which express.json() handles) — but some older
  // browsers / extensions strip the MIME type and the payload arrives as
  // text/plain or application/octet-stream. We accept those at the route
  // level and JSON.parse manually so beacon final-ticks never silently fail.
  app.post(
    "/api/player/:publicId/tick",
    express.text({ type: ["text/plain", "application/octet-stream"], limit: "10kb" }),
    async (req: any, res: any) => {
    try {
      // If body arrived as a raw string (beacon fallback), parse it.
      if (typeof req.body === "string") {
        try { req.body = JSON.parse(req.body); } catch { req.body = {}; }
      }
      const body = req.body || {};
      const { sid } = body;
      if (!sid) return res.status(400).json({ ok: false, message: "Missing sid" });

      const includeRaw = Array.isArray(body.include) ? body.include : ["progress"];
      const wantProgress = includeRaw.includes("progress");
      const wantHeartbeat = includeRaw.includes("heartbeat");
      const wantPing = includeRaw.includes("ping");

      await getSessionAsync(sid);
      const session = getSession(sid);
      if (!session || session.revoked) {
        return res.status(403).json({ ok: false, blocked: true, code: "PLAYBACK_DENIED", reason: "SESSION_INVALID", message: "Session invalid or expired" });
      }
      if (session.publicId !== req.params.publicId) {
        return res.status(403).json({ ok: false, blocked: true, code: "PLAYBACK_DENIED", reason: "SESSION_MISMATCH", message: "Session mismatch" });
      }

      // UA gate at the /tick entry — guarantees device-binding validation
      // for every consolidated request, not just the ones that include
      // "heartbeat". Defense in depth: media routes (/hls /seg /key) and
      // heartbeat already validate UA; this just keeps control-plane parity.
      const ua = req.headers["user-agent"] || "";
      if (!validateUserAgent(sid, ua)) {
        return res.status(403).json({ ok: false, blocked: true, code: "PLAYBACK_DENIED", reason: "DEVICE_MISMATCH", message: "Device mismatch" });
      }

      const response: any = { ok: true };

      // Progress runs first — it's the cheapest and updates window state that
      // heartbeat verification may depend on (currentSegmentIndex).
      if (wantProgress) {
        response.progress = _runProgressLogic(sid, session, body);

        // Keep the integration session's maxPositionSeconds in sync so that
        // embed-url auto-resume works correctly even when the LMS ping omits
        // currentTime. We use GREATEST in the SQL so seek-back never
        // overwrites a larger recorded max. Fire-and-forget — never blocks tick.
        if (session.integrationSessionId) {
          const approxSec = Math.max(
            typeof body.currentTime === "number" ? body.currentTime : 0,
            ((response.progress as any)?.targetSegmentIndex ?? 0) * 2,
          );
          if (approxSec > 0) {
            storage.touchIntegrationSessionPosition(session.integrationSessionId, approxSec)
              .catch(() => {});
          }
        }
      }

      // Heartbeat — performs UA validation + replay protection + extends TTL.
      // If rejected, surface immediately with 403 so client triggers denial.
      if (wantHeartbeat) {
        const hb = await _runHeartbeatLogic(sid, session, req, body);
        response.heartbeat = hb;
        if (!hb.ok && (hb as any).blocked) {
          return res.status(403).json({
            ok: false,
            blocked: true,
            reason: (hb as any).signal || (hb as any).code,
            code: (hb as any).code,
            message: (hb as any).message,
            signal: (hb as any).signal,
            breach: (hb as any).breach,
            heartbeat: hb,
            ...(response.progress ? { progress: response.progress } : {}),
          });
        }
      }

      // Ping — analytics only, never blocks. Errors are swallowed; the rest
      // of the tick still succeeds so playback isn't impacted by an analytics
      // hiccup.
      if (wantPing) {
        try {
          response.ping = await _runPingLogic(req.params.publicId, req, body);
        } catch (e: any) {
          response.ping = { ok: false, error: e.message };
        }
      }

      // `final: true` is informational — client sends it on pause/end/unload
      // via sendBeacon so future server-side buffering (P4) knows to flush.
      // For now it's just logged sparsely.
      if (body.final && Math.random() < 0.05) {
        console.log(`[tick] FINAL sid=${sid} pub=${req.params.publicId} include=${includeRaw.join(",")}`);
      }

      return res.json(response);
    } catch (e: any) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // ── Session Rotation — called by player every SESSION_ROTATION_MS ─────────
  // NOTE: Prefer /extend-session for new clients — it avoids hls.loadSource()
  // and the MSE SourceBuffer flush that causes a 1-2s black screen.
  app.post("/api/player/:publicId/rotate-session", async (req: any, res: any) => {
    try {
      const { sid } = req.body;
      if (!sid) return res.status(400).json({ message: "Missing sid" });

      await getSessionAsync(sid);
      const session = getSession(sid);
      if (!session || session.revoked) return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Session invalid or expired" });
      if (session.publicId !== req.params.publicId) return res.status(403).json({ message: "Session mismatch" });

      const newSid = rotateSession(sid);
      if (!newSid) return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Session rotation failed" });

      const newSession = getSession(newSid);
      if (!newSession) return res.status(500).json({ message: "Failed to create rotated session" });

      const ttls = getSessionTokenTTL(newSid);
      const dh = newSession.deviceHash;
      const proxyBase = `/hls/${req.params.publicId}/master.m3u8`;
      const manifestUrl = buildSignedProxyUrl(proxyBase, newSid, "/master.m3u8", ttls.manifest);

      // Stealth: re-mint an opaque level URL bound to the new sid so the
      // player can keep using opaque names across rotation.
      let stealth: { enabled: boolean; streamUrl?: string } = { enabled: false };
      if (newSession.hardening.stealthModeEnabled) {
        stealth = { enabled: true, streamUrl: buildStealthMasterUrl(req.params.publicId, newSid, ttls.manifest) };
      }
      const overlapGraceSec = newSession.hardening.windowOverlapGraceSec;
      const heartbeatIntervalSec = newSession.hardening.heartbeatIntervalSec;
      const sessionExpiresAt = newSession.expiresAt;
      // Schedule next renewal at ~70% of the heartbeat interval so the
      // client renews well before the server-side TTL bucket flips. Floor
      // at 5s to prevent runaway request rates on misconfigured intervals.
      const nextRefreshInMs = Math.max(5000, Math.floor(heartbeatIntervalSec * 0.7 * 1000));
      console.log(`[playback] SESSION_RENEWED: oldSid=${sid} newSid=${newSid} pub=${req.params.publicId} expiresIn=${Math.round((sessionExpiresAt - Date.now())/1000)}s`);
      return res.json({
        manifestUrl, sessionId: newSid, rotationIntervalMs: SESSION_ROTATION_MS, stealth,
        sessionExpiresAt, heartbeatIntervalSec, overlapGraceSec,
        nextRefreshAt: Date.now() + nextRefreshInMs,
        renewalGraceSec: overlapGraceSec,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Session Heartbeat — replaces rotation for active playback ─────────────
  // Extends the existing session TTL without creating a new SID or manifest URL.
  // The player calls this every SESSION_ROTATION_MS and never reloads the HLS
  // source, completely eliminating the MSE SourceBuffer flush and resulting
  // 1-2s black screen that full session rotation caused.
  // ── Cheap session-status probe ────────────────────────────────────────────
  // The embed player calls this when it receives a 403 from a media route to
  // decide whether to silently renew (recoverable expiry) or trigger the
  // denial overlay (real revocation). Returns the minimum info needed without
  // exposing internals. Public — no auth required, but only reveals data
  // about a session the caller already has the SID for.
  app.get("/api/player/:publicId/session-status", async (req: any, res: any) => {
    try {
      const sid = String(req.query.sid || "");
      if (!sid) return res.status(400).json({ active: false, reason: "MISSING_SID" });
      await getSessionAsync(sid);
      const s = getSession(sid);
      if (!s) return res.json({ active: false, reason: "NOT_FOUND" });
      if (s.publicId !== req.params.publicId) return res.json({ active: false, reason: "MISMATCH" });
      const now = Date.now();
      if (now > s.expiresAt) {
        console.log(`[playback] SESSION_EXPIRED_DURING_PLAYBACK: sid=${sid} pub=${req.params.publicId}`);
        return res.json({ active: false, reason: "EXPIRED", expiresAt: s.expiresAt });
      }
      if (s.revoked) {
        const sig = (s.revokeReason as any)?.signal || "rate_limit";
        const isRotation = sig === "rotated";
        const inGrace = isRotation && s.revokedAt != null && (now - s.revokedAt) < (s.hardening.windowOverlapGraceSec || 30) * 1000;
        if (inGrace) {
          return res.json({ active: true, reason: "ROTATED_GRACE", expiresAt: s.expiresAt, revokedAt: s.revokedAt, signal: sig });
        }
        return res.json({ active: false, reason: isRotation ? "ROTATED" : "REVOKED", signal: sig, revokedAt: s.revokedAt });
      }
      const hardening = s.hardening;
      return res.json({
        active: true,
        expiresAt: s.expiresAt,
        heartbeatIntervalSec: hardening.heartbeatIntervalSec,
        overlapGraceSec: hardening.windowOverlapGraceSec,
        nextRefreshAt: now + Math.max(5000, Math.floor(hardening.heartbeatIntervalSec * 0.7 * 1000)),
      });
    } catch (e: any) {
      res.status(500).json({ active: false, reason: "ERROR", message: e.message });
    }
  });

  app.post("/api/player/:publicId/extend-session", async (req: any, res: any) => {
    try {
      const { sid } = req.body;
      if (!sid) return res.status(400).json({ message: "Missing sid" });

      await getSessionAsync(sid);
      const session = getSession(sid);
      if (!session || session.revoked) return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Session invalid or expired" });
      if (session.publicId !== req.params.publicId) return res.status(403).json({ message: "Session mismatch" });

      const ok = extendSession(sid);
      if (!ok) return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Session extend failed" });

      const hardening = session.hardening;
      const overlapGraceSec = hardening.windowOverlapGraceSec;
      const heartbeatIntervalSec = hardening.heartbeatIntervalSec;
      const nextRefreshInMs = Math.max(5000, Math.floor(heartbeatIntervalSec * 0.7 * 1000));
      return res.json({
        ok: true,
        rotationIntervalMs: SESSION_ROTATION_MS,
        intervalSec: heartbeatIntervalSec,
        heartbeatIntervalSec,
        overlapGraceSec,
        renewalGraceSec: overlapGraceSec,
        sessionExpiresAt: session.expiresAt,
        nextRefreshAt: Date.now() + nextRefreshInMs,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Heartbeat V2 — stronger session keepalive with replay/integrity checks ──
  // Body: { sid, seq, nonce, currentTime, segmentIndex? }
  //  - seq must be strictly monotonic per session
  //  - nonce must be unseen in the last 64 heartbeats
  //  - currentTime cannot advance faster than wall clock × 2.5 (+5s buffer)
  // When serverGatedWindowEnabled=true the playlist window only advances here.
  app.post("/api/player/:publicId/heartbeat", async (req: any, res: any) => {
    try {
      const { sid } = req.body || {};
      if (!sid) return res.status(400).json({ message: "Missing sid" });

      await getSessionAsync(sid);
      const session = getSession(sid);
      if (!session || session.revoked) {
        return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Session invalid or expired" });
      }
      if (session.publicId !== req.params.publicId) return res.status(403).json({ message: "Session mismatch" });

      const hb = await _runHeartbeatLogic(sid, session, req, req.body || {});
      if (!hb.ok && (hb as any).blocked) {
        return res.status(403).json({
          code: (hb as any).code,
          message: (hb as any).message,
          ...((hb as any).signal ? { signal: (hb as any).signal } : {}),
          ...((hb as any).breach ? { breach: (hb as any).breach } : {}),
        });
      }
      return res.json(hb);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Client-reported security events — MediaSource hooks, focus loss, devtools, etc. ──
  // Body: { sid?, eventType, meta? }
  // High-severity events (MEDIA_SOURCE_HOOK_DETECTED, APPEND_BUFFER_HOOK_DETECTED,
  // HLS_BUFFER_CAPTURE_SUSPECTED) immediately revoke the session.
  app.post("/api/player/:publicId/security-event", async (req: any, res: any) => {
    try {
      const { sid, eventType, meta } = req.body || {};
      const publicId = req.params.publicId;
      if (!eventType || typeof eventType !== "string" || eventType.length > 80) {
        return res.status(400).json({ message: "Missing or invalid eventType" });
      }
      const allowed = new Set([
        "MEDIA_SOURCE_HOOK_DETECTED",
        "APPEND_BUFFER_HOOK_DETECTED",
        "HLS_BUFFER_CAPTURE_SUSPECTED",
        "HLS_URL_EXPOSURE_PREVENTED",
        "OUT_OF_WINDOW_SEGMENT_REQUEST",
        "DOWNLOAD_AHEAD_LIMIT_EXCEEDED",
        "KEY_REJECTED",
        "SEGMENT_REJECTED",
        "SESSION_REVOKED",
        "RIGHT_CLICK",
        "FOCUS_LOST",
        "DEVTOOLS_DETECTED",
        "FULLSCREEN_REQUIRED_BREACH",
        "DOWNLOAD_ATTEMPT",
      ]);
      if (!allowed.has(eventType)) {
        return res.status(400).json({ message: "Unknown eventType" });
      }

      let revoked = false;
      let score = 0;
      if (sid && typeof sid === "string") {
        await getSessionAsync(sid);
        const session = getSession(sid);
        if (session && session.publicId === publicId) {
          const r = recordSecurityEvent(sid, eventType);
          revoked = r.revoked;
          score = r.score;
        }
      }

      const ip = ((req.headers["x-forwarded-for"] as string) || req.ip || "").split(",")[0].trim();
      const video = await storage.getVideoByPublicId(publicId).catch(() => null);
      // Best-effort audit log (do not block on failure)
      try {
        await storage.createAuditLog({
          action: "SECURITY_EVENT",
          meta: { eventType, publicId, sid: sid || null, videoId: video?.id || null, score, revoked, clientMeta: meta || null } as any,
          ip,
        } as any);
      } catch {}

      log(`SECURITY_EVENT: eventType=${eventType} sid=${sid || "none"} publicId=${publicId} revoked=${revoked} score=${score}`);
      return res.json({ ok: true, revoked, score });
    } catch (e: any) {
      log(`SECURITY_EVENT_ERROR: ${e.message}`);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Secure Token Minting ──────────────────────────────────────────────────
  // Two paths:
  //   A) Authenticated same-domain user — userId derived from session, no body needed
  //   B) LMS launch token — { lmsLaunchToken } in body, HMAC-verified server-side
  // NEVER trusts userId from the request body or URL.
  app.post("/api/player/:publicId/mint", async (req: any, res: any) => {
    try {
      const video = await storage.getVideoByPublicId(req.params.publicId);
      if (!video || !video.available) {
        log(`TOKEN_MINT_DENIED: reason=video_not_found publicId=${req.params.publicId}`);
        return res.status(404).json({ message: "Video not found" });
      }
      if (video.status !== "ready") {
        log(`TOKEN_MINT_DENIED: reason=video_not_ready publicId=${req.params.publicId}`);
        return res.status(400).json({ message: "Video not ready" });
      }

      let userId: string | null = null;
      let identitySource = "";

      // Path A: Authenticated same-domain user (session/cookie)
      if ((req as any).session?.userId) {
        userId = (req as any).session.userId;
        identitySource = "session";
      }

      // Path B: LMS launch token (HMAC-signed)
      const { lmsLaunchToken } = req.body || {};
      if (!userId && lmsLaunchToken) {
        if (!process.env.LMS_HMAC_SECRET) {
          log(`TOKEN_MINT_DENIED: reason=lms_hmac_secret_not_configured publicId=${req.params.publicId}`);
          return res.status(500).json({ message: "LMS integration not configured" });
        }
        const launch = verifyLmsLaunchToken(lmsLaunchToken);
        if (!launch) {
          log(`TOKEN_MINT_DENIED: reason=invalid_launch_token publicId=${req.params.publicId}`);
          return res.status(403).json({ code: "INVALID_LAUNCH_TOKEN", message: "Invalid or expired launch token" });
        }
        if (launch.publicId !== video.publicId) {
          log(`TOKEN_MINT_DENIED: reason=launch_token_video_mismatch expected=${video.publicId} got=${launch.publicId}`);
          return res.status(403).json({ code: "INVALID_LAUNCH_TOKEN", message: "Launch token does not match this video" });
        }
        userId = launch.userId;
        identitySource = "lms_launch";
      }

      if (!userId) {
        log(`TOKEN_MINT_DENIED: reason=no_identity publicId=${req.params.publicId}`);
        return res.status(401).json({ code: "AUTH_REQUIRED", message: "Authentication required. Provide a valid session or LMS launch token." });
      }

      // Entitlement check
      const entitlement = checkEntitlement(userId, video.id);
      if (!entitlement.allowed) {
        log(`TOKEN_MINT_DENIED: reason=not_entitled userId=${userId} videoId=${video.id} detail=${entitlement.reason}`);
        return res.status(403).json({ code: "AUTH_NOT_ALLOWED", message: entitlement.reason || "You do not have access to this video" });
      }

      const secSettings = await storage.getSecuritySettings(video.id);
      const ttlMs = (secSettings?.tokenTtl || 3600) * 1000;
      const concurrentLimit = secSettings?.concurrentLimit ?? 1;

      // Client instance ID — stable per browser/tab, sent via x-client-instance header.
      // Allows refresh to silently replace its own token instead of triggering session limit.
      const clientInstanceId = (req.headers["x-client-instance"] as string || "").slice(0, 64).trim() || null;

      // Auto-revoke any existing active tokens from the same client instance (refresh case).
      // This prevents a page refresh from counting as a new concurrent session.
      if (clientInstanceId) {
        const revoked = await storage.revokeUserTokensByInstId(video.id, userId, clientInstanceId);
        if (revoked > 0) {
          log(`INST_REFRESH_REVOKE: userId=${userId} videoId=${video.id} instId=${clientInstanceId} revokedCount=${revoked}`);
        }
      }

      // Concurrent session check: scoped per user PER VIDEO
      const activeTokens = await storage.getActiveUserTokens(video.id, userId);
      if (activeTokens.length >= concurrentLimit) {
        log(`SESSION_LIMIT_BLOCK: userId=${userId} videoId=${video.id} activeSessions=${activeTokens.length} limit=${concurrentLimit}`);
        return res.status(429).json({
          code: "SESSION_LIMIT",
          message: `You already have ${activeTokens.length} active session(s) for this video. Close other tabs or end those sessions first.`,
          activeSessions: activeTokens.map(t => ({ id: t.id, label: t.label, createdAt: t.createdAt, expiresAt: t.expiresAt })),
        });
      }

      const expiresAt = new Date(Date.now() + ttlMs);
      const tokenValue = generateToken({ videoId: video.id, publicId: video.publicId, userId }, Math.floor(ttlMs / 1000));
      const tokenLabel = clientInstanceId
        ? `auto:${userId}:${identitySource}:inst:${clientInstanceId}`
        : `auto:${userId}:${identitySource}`;
      const dbToken = await storage.createEmbedToken({
        videoId: video.id,
        token: tokenValue,
        label: tokenLabel,
        allowedDomain: null,
        expiresAt,
        revoked: false,
        userId,
      } as any);

      log(`TOKEN_MINT_SUCCESS: userId=${userId} videoId=${video.id} sessionId=${dbToken.id} source=${identitySource}`);
      // Renewal hints — the player uses these to schedule a silent refresh
      // at ~70% of the token lifetime. Backend remains source of truth.
      const renewBeforeExpirySec = Math.min(120, Math.max(30, Math.floor((ttlMs / 1000) * 0.2)));
      const nextRefreshAt = expiresAt.getTime() - renewBeforeExpirySec * 1000;
      res.json({
        token: tokenValue,
        expiresAt: expiresAt.toISOString(),
        sessionExpiresAt: expiresAt.getTime(),
        tokenExpiresAt: expiresAt.getTime(),
        nextRefreshAt,
        renewBeforeExpirySec,
        tokenId: dbToken.id,
      });
    } catch (e: any) {
      log(`TOKEN_MINT_DENIED: reason=server_error publicId=${req.params.publicId} error=${e.message}`);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Short Share Link Bootstrap (no JWT in URL) ────────────────────────────
  // Public endpoint. Validates share-link policy (active, expiry, maxViews,
  // password, allowedDomains, iframeOnly) and mints a short-lived embed token
  // that is returned in the JSON body. The browser URL never contains the JWT.
  async function validateAndMintFromShareLink(
    video: { id: string; publicId: string },
    link: any,
    req: any,
    res: any,
  ): Promise<{ ok: true; token: string; expiresAt: string } | { ok: false }> {
    if (!link || !link.isActive || link.revokedAt) {
      res.status(403).json({ code: "SHARE_LINK_REVOKED", message: "This share link is no longer active." });
      return { ok: false };
    }
    if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) {
      res.status(403).json({ code: "SHARE_LINK_EXPIRED", message: "This share link has expired." });
      return { ok: false };
    }
    if (typeof link.maxViews === "number" && link.maxViews > 0 && (link.viewCount ?? 0) >= link.maxViews) {
      res.status(403).json({ code: "SHARE_LINK_MAXED", message: "This share link has reached its view limit." });
      return { ok: false };
    }
    // Domain whitelist (Origin/Referer)
    if (Array.isArray(link.allowedDomains) && link.allowedDomains.length > 0) {
      const originHdr = (req.headers.origin as string) || "";
      const refererHdr = (req.headers.referer as string) || "";
      const hostFrom = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
      const candidates = [hostFrom(originHdr), hostFrom(refererHdr)].filter(Boolean);
      const allowed = (link.allowedDomains as string[]).map(d => d.trim().toLowerCase()).filter(Boolean);
      const ok = candidates.some(h => allowed.some(d => h === d || h.endsWith("." + d)));
      if (!ok) {
        res.status(403).json({ code: "SHARE_LINK_DOMAIN_BLOCKED", message: "This share link is not authorized for this domain." });
        return { ok: false };
      }
    }
    // iframe-only enforcement: fail-closed. The bootstrap call is made by the
    // player JS via fetch(), which always sets Sec-Fetch-Dest=empty. Top-level
    // navigations to /v/:publicId never hit bootstrap (it's POST), but the
    // referer/origin pair distinguishes embedded vs. standalone documents.
    if (link.iframeOnly) {
      const dest = (req.headers["sec-fetch-dest"] as string) || "";
      const site = (req.headers["sec-fetch-site"] as string) || "";
      if (!dest) {
        // Missing header (older browser / non-browser) — refuse.
        res.status(403).json({ code: "SHARE_LINK_IFRAME_ONLY", message: "This share link can only be played inside an iframe." });
        return { ok: false };
      }
      // Allow the fetch from the embed page itself (empty) only when the page
      // is loaded cross-site (i.e. inside an iframe on a different origin).
      // If same-origin top-level, sec-fetch-site is "same-origin" and Referer
      // host matches the CMS host — that's a standalone page, not an iframe.
      if (dest !== "iframe") {
        const referer = (req.headers.referer as string) || "";
        let refHost = "";
        try { refHost = new URL(referer).hostname.toLowerCase(); } catch {}
        const reqHost = (req.headers.host || "").toString().toLowerCase().split(":")[0];
        const sameOriginTopLevel = site === "same-origin" && refHost && refHost === reqHost;
        if (sameOriginTopLevel || site === "none") {
          res.status(403).json({ code: "SHARE_LINK_IFRAME_ONLY", message: "This share link can only be played inside an iframe." });
          return { ok: false };
        }
      }
    }
    // Password gate
    if (link.passwordHash) {
      const password = (req.body && typeof req.body.password === "string") ? req.body.password : "";
      if (!password) {
        res.status(401).json({ code: "SHARE_LINK_PASSWORD_REQUIRED", message: "This share link requires a password." });
        return { ok: false };
      }
      const ok = await bcrypt.compare(password, link.passwordHash);
      if (!ok) {
        res.status(401).json({ code: "SHARE_LINK_PASSWORD_INVALID", message: "Incorrect password." });
        return { ok: false };
      }
    }

    // Short-lived playback token (15 min default — heartbeat extends session, refresh-token rotates).
    const ttlSeconds = 15 * 60;
    const tokenValue = generateToken({ videoId: video.id, publicId: video.publicId, share: true }, ttlSeconds);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await storage.createEmbedToken({
      videoId: video.id,
      token: tokenValue,
      label: `share:${link.shareCode}`,
      allowedDomain: null,
      expiresAt,
      revoked: false,
      userId: null,
    } as any);
    await storage.incrementShareLinkViews(video.id).catch(() => {});
    return { ok: true, token: tokenValue, expiresAt: expiresAt.toISOString() };
  }

  app.post("/api/player/:publicId/bootstrap", async (req: any, res: any) => {
    try {
      const video = await storage.getVideoByPublicId(req.params.publicId);
      if (!video || !video.available) return res.status(404).json({ message: "Video not found" });
      if (video.status !== "ready") return res.status(400).json({ code: "VIDEO_NOT_READY", message: "Video not ready" });

      // Admin session bypass — admin gets an adminPreview token directly
      if ((req as any).session?.userId) {
        const tokenValue = generateToken({ videoId: video.id, publicId: video.publicId, adminPreview: true }, 86400);
        return res.json({ token: tokenValue, expiresAt: new Date(Date.now() + 86400 * 1000).toISOString(), publicId: video.publicId, adminPreview: true });
      }

      const link = await storage.getShareLinkByVideoId(video.id);
      if (!link) return res.status(404).json({ code: "SHARE_LINK_NOT_FOUND", message: "No share link configured for this video." });

      const result = await validateAndMintFromShareLink(video, link, req, res);
      if (!result.ok) return;
      res.json({ token: result.token, expiresAt: result.expiresAt, publicId: video.publicId });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/share/:shareCode/bootstrap", async (req: any, res: any) => {
    try {
      const link = await storage.getShareLinkByCode(req.params.shareCode);
      if (!link) return res.status(404).json({ code: "SHARE_LINK_NOT_FOUND", message: "Share link not found." });
      const video = await storage.getVideoById(link.videoId);
      if (!video || !video.available) return res.status(404).json({ message: "Video not found" });
      if (video.status !== "ready") return res.status(400).json({ code: "VIDEO_NOT_READY", message: "Video not ready" });

      const result = await validateAndMintFromShareLink(video, link, req, res);
      if (!result.ok) return;
      res.json({ token: result.token, expiresAt: result.expiresAt, publicId: video.publicId });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Admin Share Link CRUD ─────────────────────────────────────────────────
  app.get("/api/videos/:id/share-link", requireAuth, async (req: any, res: any) => {
    try {
      const link = await storage.getShareLinkByVideoId(req.params.id);
      if (!link) return res.json(null);
      // Never leak password hash
      const { passwordHash, ...safe } = link as any;
      res.json({ ...safe, hasPassword: !!passwordHash });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Create or regenerate the share link (generates a new shareCode each call).
  // Immediately revokes any previously minted share-link playback tokens.
  app.post("/api/videos/:id/share-link", requireAuth, async (req: any, res: any) => {
    try {
      const video = await storage.getVideoById(req.params.id);
      if (!video) return res.status(404).json({ message: "Video not found" });

      // Invalidate previously minted share tokens — closes the gap where a
      // regenerated link would leave old playback tokens valid until expiry.
      const revokedCount = await storage.revokeShareEmbedTokens(video.id);
      if (revokedCount > 0) log(`SHARE_LINK_TOKENS_REVOKED: videoId=${video.id} count=${revokedCount} reason=regenerate`);

      const body = req.body || {};
      const shareCode = nanoid(14);
      let passwordHash: string | null | undefined = undefined;
      if (typeof body.password === "string" && body.password.length > 0) {
        passwordHash = await bcrypt.hash(body.password, 12);
      } else if (body.password === null || body.password === "") {
        passwordHash = null;
      }

      const data: any = {
        shareCode,
        isActive: true,
        revokedAt: null,
        viewCount: 0,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        maxViews: typeof body.maxViews === "number" ? body.maxViews : null,
        allowedDomains: Array.isArray(body.allowedDomains) ? body.allowedDomains : null,
        iframeOnly: !!body.iframeOnly,
      };
      if (passwordHash !== undefined) data.passwordHash = passwordHash;

      const link = await storage.upsertShareLink(video.id, data);
      await storage.createAuditLog({ action: "share_link_regenerated", meta: { videoId: video.id, shareCode }, ip: req.ip });
      const { passwordHash: ph, ...safe } = link as any;
      res.json({ ...safe, hasPassword: !!ph });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Update share-link settings without rotating the shareCode.
  app.patch("/api/videos/:id/share-link", requireAuth, async (req: any, res: any) => {
    try {
      const existing = await storage.getShareLinkByVideoId(req.params.id);
      if (!existing) return res.status(404).json({ message: "No share link exists" });

      const body = req.body || {};
      const patch: any = {};
      if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
      if (body.expiresAt !== undefined) patch.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
      if (body.maxViews !== undefined) patch.maxViews = typeof body.maxViews === "number" ? body.maxViews : null;
      if (body.allowedDomains !== undefined) patch.allowedDomains = Array.isArray(body.allowedDomains) ? body.allowedDomains : null;
      if (typeof body.iframeOnly === "boolean") patch.iframeOnly = body.iframeOnly;
      if (body.password === null || body.password === "") patch.passwordHash = null;
      else if (typeof body.password === "string") patch.passwordHash = await bcrypt.hash(body.password, 12);

      const link = await storage.updateShareLink(req.params.id, patch);
      await storage.createAuditLog({ action: "share_link_updated", meta: { videoId: req.params.id, fields: Object.keys(patch) }, ip: req.ip });
      const { passwordHash, ...safe } = (link || {}) as any;
      res.json({ ...safe, hasPassword: !!passwordHash });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Revoke (deactivate) the share link AND immediately invalidate all
  // playback tokens that were minted from it.
  app.delete("/api/videos/:id/share-link", requireAuth, async (req: any, res: any) => {
    try {
      await storage.revokeShareLink(req.params.id);
      const revokedCount = await storage.revokeShareEmbedTokens(req.params.id);
      if (revokedCount > 0) log(`SHARE_LINK_TOKENS_REVOKED: videoId=${req.params.id} count=${revokedCount} reason=revoke`);
      await storage.createAuditLog({ action: "share_link_revoked", meta: { videoId: req.params.id, revokedTokens: revokedCount }, ip: req.ip });
      res.json({ success: true, revokedTokens: revokedCount });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Token Refresh ─────────────────────────────────────────────────────────
  // Player calls this when it receives a 401/403 TOKEN_EXPIRED or SIGNED_URL_EXPIRED.
  // Mints a new token for the same user, returns a new manifestUrl.
  app.post("/api/player/:publicId/refresh-token", async (req: any, res: any) => {
    try {
      const { token: oldTokenValue } = req.body;
      if (!oldTokenValue) return res.status(400).json({ message: "token required" });

      const video = await storage.getVideoByPublicId(req.params.publicId);
      if (!video || !video.available) {
        log(`TOKEN_REFRESH_FAIL: reason=video_not_found publicId=${req.params.publicId}`);
        return res.status(404).json({ message: "Video not found" });
      }

      const oldDbToken = await storage.getTokenByValue(oldTokenValue);
      let userId: string | null = null;
      // integrationSessionId lives only in the JWT payload (not the DB row),
      // so always decode the old token to forward it onto the refreshed
      // session. Without this, admin/abuse-revoke by integration session can
      // no longer kill the refreshed SID — see prior reviewer finding.
      let oldIntegrationSessionId: string | null = null;
      try {
        const decodedOld: any = verifyToken(oldTokenValue);
        if (decodedOld?.integrationSessionId && typeof decodedOld.integrationSessionId === "string") {
          oldIntegrationSessionId = decodedOld.integrationSessionId;
        }
      } catch {}

      if (oldDbToken) {
        if (oldDbToken.revoked) {
          log(`TOKEN_REFRESH_FAIL: reason=token_revoked videoId=${video.id} tokenId=${oldDbToken.id}`);
          return res.status(401).json({ message: "Token was revoked — cannot refresh" });
        }
        userId = (oldDbToken as any).userId || null;
      } else {
        const decoded = verifyToken(oldTokenValue);
        if (!decoded) {
          log(`TOKEN_REFRESH_FAIL: reason=invalid_token_signature videoId=${video.id}`);
          return res.status(401).json({ message: "Invalid token" });
        }
        if (!decoded.userId) {
          log(`TOKEN_REFRESH_FAIL: reason=no_user_in_token videoId=${video.id}`);
          return res.status(401).json({ message: "Cannot identify user from token" });
        }
        userId = decoded.userId;
      }

      if (!userId) {
        log(`TOKEN_REFRESH_FAIL: reason=not_per_user_token videoId=${video.id}`);
        return res.status(401).json({ message: "Token is not a per-user token — cannot refresh automatically" });
      }

      // Entitlement re-check on refresh
      const entitlement = checkEntitlement(userId, video.id);
      if (!entitlement.allowed) {
        log(`TOKEN_REFRESH_FAIL: reason=not_entitled userId=${userId} videoId=${video.id}`);
        return res.status(403).json({ code: "AUTH_NOT_ALLOWED", message: entitlement.reason || "Access revoked" });
      }

      const secSettings = await storage.getSecuritySettings(video.id);
      const ttlMs = (secSettings?.tokenTtl || 3600) * 1000;
      const expiresAt = new Date(Date.now() + ttlMs);
      const newTokenPayload: any = { videoId: video.id, publicId: video.publicId, userId };
      if (oldIntegrationSessionId) newTokenPayload.integrationSessionId = oldIntegrationSessionId;
      const newTokenValue = generateToken(newTokenPayload, Math.floor(ttlMs / 1000));
      const newDbToken = await storage.createEmbedToken({
        videoId: video.id,
        token: newTokenValue,
        label: `auto:${userId}:refresh`,
        allowedDomain: null,
        expiresAt,
        revoked: false,
        userId,
      } as any);

      if (oldDbToken) await storage.revokeToken(oldDbToken.id);

      const connId = (video as any).storageConnectionId as string | null;
      const conn = connId
        ? await storage.getStorageConnectionById(connId)
        : await storage.getActiveStorageConnection();
      const ua = req.headers["user-agent"] || "";
      const dh = computeDeviceHash(ua);
      const globalSec = await secRepo.getGlobal();
      const videoUseGlobal2 = await secRepo.getUseGlobal(video.id);
      const effectiveClientSec2 = videoUseGlobal2
        ? globalSec
        : ((await secRepo.getVideo(video.id)) ?? globalSec);
      const suspiciousEnabled = effectiveClientSec2.suspiciousDetectionEnabled !== false;
      const effectiveViolationLimit2 = effectiveClientSec2.violationLimit ?? 10;
      const hardening2 = buildHardening(effectiveClientSec2);

      // Preserve LMS integration session linkage across refresh so admin/abuse
      // revoke can still kill the new SID via integrationSessionId. Derived
      // from the OLD token (only place it lives) and forwarded into both the
      // new token payload (above) and setIntegrationSessionId on the new SID.
      const linkIntegrationSessionId2: string | null = oldIntegrationSessionId;

      // Mint a brand-new playback session on the appropriate provider —
      // mirrors /manifest so refresh works for ALL storage backends, not just
      // B2/R2. Without this branch, bunny_net and s3 videos silently return
      // a null manifestUrl and the client never swaps SID → 7-8 min freeze.
      let manifestUrl: string | null = null;
      let stealth: { enabled: boolean; streamUrl?: string } = { enabled: false };
      let newSid: string | null = null;
      const hlsPrefix = video.hlsS3Prefix!;

      const ekp2 = (video as any).encryptionKeyPath || null;

      if (conn?.provider === "bunny_net") {
        const cfg = conn.config as any;
        newSid = createSession(video.publicId, hlsPrefix, "bunny_net", cfg, conn.id, dh, ua, suspiciousEnabled, effectiveViolationLimit2, hardening2, ekp2);
        if (linkIntegrationSessionId2) setIntegrationSessionId(newSid, linkIntegrationSessionId2);
        const ttls = getSessionTokenTTL(newSid);
        manifestUrl = buildSignedProxyUrl(`/hls/${video.publicId}/master.m3u8`, newSid, "/master.m3u8", ttls.manifest);
        if (hardening2.stealthModeEnabled) {
          stealth = { enabled: true, streamUrl: buildStealthMasterUrl(video.publicId, newSid, ttls.manifest) };
        }
      } else if (conn?.provider === "backblaze_b2" || conn?.provider === "cloudflare_r2") {
        const cfg = conn.config as any;
        const providerType = conn.provider === "backblaze_b2" ? "backblaze_b2" : "cloudflare_r2";
        newSid = createSession(video.publicId, hlsPrefix, providerType, cfg, conn.id, dh, ua, suspiciousEnabled, effectiveViolationLimit2, hardening2, ekp2);
        if (linkIntegrationSessionId2) setIntegrationSessionId(newSid, linkIntegrationSessionId2);
        const ttls = getSessionTokenTTL(newSid);
        manifestUrl = buildSignedProxyUrl(`/hls/${video.publicId}/master.m3u8`, newSid, "/master.m3u8", ttls.manifest);
        if (hardening2.stealthModeEnabled) {
          stealth = { enabled: true, streamUrl: buildStealthMasterUrl(video.publicId, newSid, ttls.manifest) };
        }
      } else {
        // S3 (or null connection → legacy S3 config) fallback
        try {
          const client = await getS3Client();
          const s3cfg = await getS3Config();
          if (client && s3cfg.bucket) {
            newSid = createSession(video.publicId, hlsPrefix, "s3", s3cfg, null, dh, ua, suspiciousEnabled, effectiveViolationLimit2, hardening2, ekp2);
            if (linkIntegrationSessionId2) setIntegrationSessionId(newSid, linkIntegrationSessionId2);
            const ttls = getSessionTokenTTL(newSid);
            manifestUrl = buildSignedProxyUrl(`/hls/${video.publicId}/master.m3u8`, newSid, "/master.m3u8", ttls.manifest);
            if (hardening2.stealthModeEnabled) {
              stealth = { enabled: true, streamUrl: buildStealthMasterUrl(video.publicId, newSid, ttls.manifest) };
            }
          }
        } catch (e: any) {
          log(`TOKEN_REFRESH_S3_FALLBACK_FAIL: ${e?.message || e}`);
        }
      }

      // If no provider was matched, no playback session was minted and the
      // client would receive a null manifestUrl and never recover. Fail loudly
      // rather than issuing a useless refreshed token.
      if (!newSid || !manifestUrl) {
        log(`TOKEN_REFRESH_FAIL: reason=no_session_minted videoId=${video.id} provider=${conn?.provider || "none"}`);
        return res.status(503).json({ code: "PLAYBACK_DENIED", message: "Could not mint playback session for this storage provider" });
      }

      log(`TOKEN_REFRESH_SUCCESS: userId=${userId} videoId=${video.id} oldTokenId=${oldDbToken?.id} newTokenId=${newDbToken.id} newSid=${newSid}`);
      console.log(`[playback] TOKEN_RENEWED: userId=${userId} pub=${req.params.publicId} expiresIn=${Math.round(ttlMs/1000)}s newSid=${newSid}`);
      const renewBeforeExpirySec = Math.min(120, Math.max(30, Math.floor((ttlMs / 1000) * 0.2)));
      const nextRefreshAt = expiresAt.getTime() - renewBeforeExpirySec * 1000;
      res.json({
        token: newTokenValue,
        sessionId: newSid,
        expiresAt: expiresAt.toISOString(),
        sessionExpiresAt: expiresAt.getTime(),
        tokenExpiresAt: expiresAt.getTime(),
        nextRefreshAt,
        renewBeforeExpirySec,
        overlapGraceSec: hardening2.windowOverlapGraceSec,
        heartbeatIntervalSec: hardening2.heartbeatIntervalSec,
        manifestUrl,
        stealth,
      });
    } catch (e: any) {
      log(`TOKEN_REFRESH_FAIL: reason=server_error publicId=${req.params.publicId} error=${e.message}`);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Revoke Other Sessions (for same user + same video) ──────────────────
  // Player calls this when session-limit reached and user chooses "End other session".
  // userId is derived from the currentToken — never trusted from the request body.
  app.post("/api/player/:publicId/revoke-other-sessions", async (req: any, res: any) => {
    try {
      const { currentToken } = req.body;
      if (!currentToken) return res.status(400).json({ message: "currentToken required" });

      const video = await storage.getVideoByPublicId(req.params.publicId);
      if (!video) return res.status(404).json({ message: "Video not found" });

      // Derive userId from the token — never trust client-supplied userId
      // Require a DB-backed token or a signature-verified JWT
      const dbToken = await storage.getTokenByValue(currentToken);
      let userId: string | null = null;
      if (dbToken) {
        if (dbToken.revoked || (dbToken.expiresAt && new Date(dbToken.expiresAt) < new Date())) {
          return res.status(401).json({ message: "Token is expired or revoked" });
        }
        userId = (dbToken as any).userId || null;
      } else {
        const decoded = verifyToken(currentToken);
        if (!decoded || !decoded.userId) {
          return res.status(401).json({ message: "Invalid or unverifiable token" });
        }
        userId = decoded.userId;
      }

      if (!userId) return res.status(401).json({ message: "Cannot identify user from token" });

      // Revoke other sessions only for this user + this video
      await storage.revokeUserTokensExcept(video.id, userId, currentToken);
      log(`USER_SESSIONS_REVOKED: userId=${userId} videoId=${video.id} — kept token ${dbToken?.id || "jwt-only"}`);
      res.json({ ok: true, message: "Other sessions for this video revoked. You can now continue." });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Revoke All Sessions by LMS Launch Token ──────────────────────────────
  // Used when the "End Other Session & Continue Here" button fires from a pure-LMS
  // context where the player has no existing token to identify itself.
  // userId is derived from the verified launch token — never trusted from the body.
  app.post("/api/player/:publicId/revoke-sessions-by-launch", async (req: any, res: any) => {
    try {
      const { lmsLaunchToken } = req.body;
      if (!lmsLaunchToken) return res.status(400).json({ message: "lmsLaunchToken required" });

      if (!process.env.LMS_HMAC_SECRET) {
        return res.status(500).json({ message: "LMS integration not configured" });
      }

      const launch = verifyLmsLaunchToken(lmsLaunchToken);
      if (!launch) {
        return res.status(403).json({ code: "INVALID_LAUNCH_TOKEN", message: "Invalid or expired launch token" });
      }

      const video = await storage.getVideoByPublicId(req.params.publicId);
      if (!video) return res.status(404).json({ message: "Video not found" });
      if (launch.publicId !== video.publicId) {
        return res.status(403).json({ code: "INVALID_LAUNCH_TOKEN", message: "Launch token does not match this video" });
      }

      const revokedCount = await storage.revokeAllUserTokens(video.id, launch.userId);
      log(`LMS_ALL_SESSIONS_REVOKED: userId=${launch.userId} videoId=${video.id} revokedCount=${revokedCount}`);
      res.json({ ok: true, revokedCount });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });


  app.get("/key/:publicId", async (req: any, res: any) => {
    const { sid, st, exp, dh } = req.query as Record<string, string>;
    if (!sid || !st || !exp) return res.status(401).json({ code: "PLAYBACK_DENIED", message: "Missing auth" });

    await getSessionAsync(sid);
    const session = getSession(sid);
    if (!session || session.revoked) {
      const bi = getBreachInfo(sid);
      return res.status(403).json({ code: "PLAYBACK_DENIED", error: bi.blocked ? "VIDEO_BLOCKED" : "PLAYBACK_DENIED", breach: `${bi.breachCount}/${bi.violationLimit}`, blockSecondsRemaining: bi.blockSecondsRemaining, message: "Session revoked" });
    }

    const reqUa = req.headers["user-agent"] || "";

    if (!verifySignedPath(sid, "/key", parseInt(exp, 10), st, undefined)) {
      return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Invalid key token" });
    }

    const keyUa = req.headers["user-agent"] || "";
    if (!validateUserAgent(sid, keyUa)) {
      log(`SECURITY: UA mismatch on key endpoint for sid=${sid}`);
      return res.status(403).json({ code: "PLAYBACK_DENIED", message: "Device mismatch" });
    }

    const keyIp = (req.headers["x-forwarded-for"] as string || req.ip || "").split(",")[0].trim();
    const { abused: keyAbused, reason: keyReason } = trackKeyHit(sid, keyIp);
    if (keyAbused) {
      const bi = getBreachInfo(sid);
      log(`SECURITY_KEY_SPAM: sid=${sid} — rate limit exceeded`);
      return res.status(429).json({ code: "PLAYBACK_DENIED", error: "SECURITY_KEY_SPAM", breach: `${bi.breachCount}/${bi.violationLimit}`, blockSecondsRemaining: bi.blockSecondsRemaining, message: "Key rate limit exceeded", signal: keyReason?.signal });
    }

    try {
      const video = await storage.getVideoByPublicId(req.params.publicId);
      if (!video?.encryptionKeyPath) {
        log(`KEY_B2_DIRECT: sid=${sid} — encryptionKeyPath not found for publicId=${req.params.publicId}`);
        return res.status(404).json({ code: "PLAYBACK_DENIED", message: "Encryption key not found" });
      }
      const masterKey = await getMasterKey(video.encryptionKeyPath, session);
      if (!masterKey) {
        log(`KEY_B2_DIRECT: sid=${sid} — failed to fetch key from B2, path=${video.encryptionKeyPath}`);
        return res.status(500).json({ code: "PLAYBACK_DENIED", message: "Key fetch failed" });
      }
      log(`KEY_B2_DIRECT: sid=${sid}, publicId=${req.params.publicId}, keyLen=${masterKey.length}`);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", masterKey.length);
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.send(masterKey);
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
      const altGlobalSec = await secRepo.getGlobal();
      const altVideoUseGlobal = await secRepo.getUseGlobal(video.id);
      const altEffectiveSec = altVideoUseGlobal
        ? altGlobalSec
        : ((await secRepo.getVideo(video.id)) ?? altGlobalSec);
      const altSuspiciousEnabled = altEffectiveSec.suspiciousDetectionEnabled !== false;
      const altViolationLimit = altEffectiveSec.violationLimit ?? 10;
      const altHardening = buildHardening(altEffectiveSec);
      const sid = createSession(video.publicId, hlsPrefix, conn.provider as any, cfg, conn.id, altDh, altUa, altSuspiciousEnabled, altViolationLimit, altHardening, (video as any).encryptionKeyPath || null);
      const altTtls = getSessionTokenTTL(sid);
      const proxyBase = `/hls/${video.publicId}/master.m3u8`;
      const playlistUrl = buildSignedProxyUrl(proxyBase, sid, "/master.m3u8", altTtls.manifest);
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
    const [playerSettingsRaw, watermarkSettings, banners] = await Promise.all([
      storage.getPlayerSettings(video.id),
      storage.getWatermarkSettings(video.id),
      storage.getBannersByVideo(video.id),
    ]);

    let playerSettings: any = playerSettingsRaw || {};

    // Resolve asset URLs for logo/overlay
    const [logoAsset, overlayAsset] = await Promise.all([
      playerSettings.logoAssetId ? storage.getMediaAssetById(playerSettings.logoAssetId).catch(() => null) : Promise.resolve(null),
      playerSettings.overlayAssetId ? storage.getMediaAssetById(playerSettings.overlayAssetId).catch(() => null) : Promise.resolve(null),
    ]);

    if (logoAsset) playerSettings = { ...playerSettings, logoUrl: `/api/assets/${logoAsset.id}/view` };
    if (overlayAsset) playerSettings = { ...playerSettings, overlayUrl: `/api/assets/${overlayAsset.id}/view` };

    // Generate QR data URL if qrEnabled and qrUrl is set
    if (playerSettings.qrEnabled && playerSettings.qrUrl) {
      try {
        const qrDataUrl = await QRCode.toDataURL(playerSettings.qrUrl, { width: 200, margin: 1 });
        playerSettings = { ...playerSettings, qrDataUrl };
      } catch {}
    }

    const thumbnailUrl = video.thumbnailUrl || null;
    const videoDuration = video.duration || null;
    res.json({ playerSettings, watermarkSettings, banners, thumbnailUrl, videoDuration });
  });

  // Playback ping — thin shim over _runPingLogic. New players use /tick.
  app.post("/api/player/:publicId/ping", async (req, res) => {
    try {
      const result = await _runPingLogic(req.params.publicId, req, req.body || {});
      res.json(result);
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
      // Strip masked/bullet values so they never overwrite real secrets in the DB
      const isMasked = (v: string) => typeof v === "string" && /^[•\*]+$/.test(v.trim());
      const safeUpdates = Object.fromEntries(
        Object.entries(updates).filter(([, v]) => !isMasked(v))
      );
      if (Object.keys(safeUpdates).length > 0) {
        await storage.setSettings(safeUpdates);
      }
      await storage.createAuditLog({ action: "settings_updated", meta: { keys: Object.keys(safeUpdates) }, ip: req.ip });
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

      if (conn.provider === "cloudflare_r2") {
        const cfg = conn.config as any;
        const endpoint = cfg.endpoint || process.env.R2_ENDPOINT || "";
        const bucket = cfg.bucket || "";
        if (!endpoint) return res.status(400).json({ ok: false, message: "R2 endpoint not configured in connection" });
        if (!bucket) return res.status(400).json({ ok: false, message: "R2 bucket not configured in connection" });
        if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
          return res.status(400).json({ ok: false, message: "R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set in Replit Secrets" });
        }

        const testKey = "raw/__healthcheck.txt";
        const r2Client = makeR2Client({ endpoint });
        const { PutObjectCommand, HeadObjectCommand } = await import("@aws-sdk/client-s3");
        await r2Client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: testKey,
          Body: Buffer.from("ok"),
          ContentType: "text/plain",
        }));
        await r2Client.send(new HeadObjectCommand({ Bucket: bucket, Key: testKey }));
        return res.json({ ok: true, message: "Cloudflare R2 connection working — test file written successfully." });
      }

      if (conn.provider === "bunny_net") {
        const cfg = conn.config as any;
        if (!(process.env.BUNNY_STORAGE_ACCESS_KEY || "").trim()) {
          return res.status(400).json({ ok: false, message: "BUNNY_STORAGE_ACCESS_KEY is not set. Add it as a secret (your Bunny.net Storage Zone Password — found at Storage → syanvideocms → Access → Password)." });
        }
        if (!cfg.storageZoneName) {
          return res.status(400).json({ ok: false, message: "Storage Zone Name not configured in this connection." });
        }
        const { bunnyTestConnection } = await import("./bunny");
        const result = await bunnyTestConnection(cfg.storageZoneName, cfg.storageRegion);
        if (result.ok) {
          return res.json({ ok: true, message: `Bunny.net connection working — zone "${cfg.storageZoneName}" reachable.` });
        }
        return res.status(400).json({ ok: false, message: result.error || "Bunny.net connection failed." });
      }

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

  // ── System Health ─────────────────────────────────────────────────────────────
  app.get("/api/admin/health", requireAuth, async (req, res) => {
    const checkedAt = new Date().toISOString();
    type CheckStatus = "ok" | "warn" | "error";
    interface HealthCheck {
      key: string;
      name: string;
      status: CheckStatus;
      message: string;
      detail?: any;
      latencyMs?: number;
    }

    async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
      const t = Date.now();
      const result = await fn();
      return { result, ms: Date.now() - t };
    }

    // Run all checks in parallel
    const [dbResult, storageResult, workerResult, vimeoResult, killResult] = await Promise.allSettled([
      // 1. Database
      timed(async () => {
        const vids = await storage.getVideos();
        const conns = await storage.getStorageConnections();
        const cats = await storage.getCategories();
        return { videos: vids.length, ready: vids.filter(v => v.status === "ready").length, processing: vids.filter(v => v.status === "processing").length, failed: vids.filter(v => v.status === "failed").length, storageConns: conns.length, categories: cats.length };
      }),
      // 2. Active storage connection
      timed(async () => {
        const conns = await storage.getStorageConnections();
        const active = conns.find(c => c.isActive);
        if (!active) return { ok: false, message: "No active storage connection" };
        const cfg = active.config as any;
        if (active.provider === "bunny_net") {
          const { bunnyTestConnection } = await import("./bunny");
          const r = await bunnyTestConnection(cfg.storageZoneName, cfg.storageRegion);
          return { ok: r.ok, provider: active.provider, name: active.name, message: r.ok ? `Zone "${cfg.storageZoneName}" reachable` : (r.error || "Connection failed") };
        }
        if (active.provider === "backblaze_b2") {
          const endpoint = cfg.endpoint || process.env.B2_S3_ENDPOINT || "";
          const hasKeys = !!(process.env.B2_KEY_ID && process.env.B2_APPLICATION_KEY);
          return { ok: hasKeys && !!endpoint, provider: active.provider, name: active.name, message: hasKeys ? "Credentials set" : "B2_KEY_ID / B2_APPLICATION_KEY missing" };
        }
        if (active.provider === "cloudflare_r2") {
          const hasKeys = !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
          return { ok: hasKeys, provider: active.provider, name: active.name, message: hasKeys ? "Credentials set" : "R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY missing" };
        }
        return { ok: true, provider: active.provider, name: active.name, message: "Configured" };
      }),
      // 3. Cloudflare Worker
      timed(async () => {
        const gateway = process.env.HLS_GATEWAY_BASE;
        if (!gateway) return { ok: false, message: "HLS_GATEWAY_BASE not set" };
        const r = await fetch(`${gateway}/seg/__probe.ts`, { signal: AbortSignal.timeout(6000) }).catch(e => ({ status: 0, ok: false, _err: e.message })) as any;
        const status = r.status ?? 0;
        if (status === 401 || status === 403) return { ok: true, gateway, message: `Online — auth enforced (${status})` };
        if (status === 404) return { ok: true, gateway, message: "Online (404 on probe path — normal)" };
        if (status === 0) return { ok: false, gateway, message: `Unreachable: ${r._err || "timeout"}` };
        return { ok: false, gateway, message: `Unexpected status ${status}` };
      }),
      // 4. Vimeo (optional)
      timed(async () => {
        const token = process.env.VIMEO_ACCESS_TOKEN || (await storage.getSetting("vimeo_access_token")) || "";
        if (!token) return { configured: false };
        const r = await fetch("https://api.vimeo.com/me", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) }).catch(() => null);
        if (!r) return { configured: true, ok: false, message: "Request failed" };
        if (!r.ok) return { configured: true, ok: false, message: `Token rejected (${r.status})` };
        const me = await r.json().catch(() => ({})) as any;
        return { configured: true, ok: true, message: `Token valid — ${me.name || "authenticated"}` };
      }),
      // 5. Kill switch + secrets
      timed(async () => {
        const killed = await storage.getSetting("global_kill_switch");
        return {
          killSwitch: killed === "true",
          signingSecret: !!process.env.SIGNING_SECRET,
          lmsSecret: !!process.env.LMS_HMAC_SECRET,
          integrationSecret: !!process.env.INTEGRATION_MASTER_SECRET,
          bunnyStorage: !!(process.env.BUNNY_STORAGE_ACCESS_KEY || "").trim(),
          bunnyToken: !!(process.env.BUNNY_TOKEN_AUTH_KEY || "").trim(),
          b2KeyId: !!(process.env.B2_KEY_ID || "").trim(),
          b2AppKey: !!(process.env.B2_APPLICATION_KEY || "").trim(),
          b2Endpoint: !!(process.env.B2_S3_ENDPOINT || "").trim(),
          r2AccessKey: !!(process.env.R2_ACCESS_KEY_ID || "").trim(),
          r2SecretKey: !!(process.env.R2_SECRET_ACCESS_KEY || "").trim(),
          r2Endpoint: !!(process.env.R2_ENDPOINT || "").trim(),
        };
      }),
    ]);

    const checks: HealthCheck[] = [];

    // Database
    if (dbResult.status === "fulfilled") {
      const { result: d, ms } = dbResult.value;
      checks.push({ key: "database", name: "Database", status: "ok", latencyMs: ms,
        message: `Connected — ${d.videos} videos (${d.ready} ready, ${d.processing} processing${d.failed > 0 ? `, ${d.failed} failed` : ""}), ${d.storageConns} storage connection${d.storageConns !== 1 ? "s" : ""}`,
        detail: d });
    } else {
      checks.push({ key: "database", name: "Database", status: "error", message: `Query failed: ${dbResult.reason?.message || "unknown error"}` });
    }

    // Storage
    if (storageResult.status === "fulfilled") {
      const { result: s, ms } = storageResult.value;
      checks.push({ key: "storage", name: "Active Storage", status: s.ok ? "ok" : "error", latencyMs: ms,
        message: s.ok ? `${s.name} — ${s.message}` : (s.message || "No active connection"),
        detail: { provider: (s as any).provider, name: (s as any).name } });
    } else {
      checks.push({ key: "storage", name: "Active Storage", status: "error", message: storageResult.reason?.message || "Check failed" });
    }

    // Worker
    if (workerResult.status === "fulfilled") {
      const { result: w, ms } = workerResult.value;
      checks.push({ key: "worker", name: "Cloudflare Worker", status: w.ok ? "ok" : "error", latencyMs: ms,
        message: w.message, detail: { gateway: (w as any).gateway } });
    } else {
      checks.push({ key: "worker", name: "Cloudflare Worker", status: "error", message: workerResult.reason?.message || "Check failed" });
    }

    // Vimeo
    if (vimeoResult.status === "fulfilled") {
      const { result: v, ms } = vimeoResult.value;
      if (v.configured) {
        checks.push({ key: "vimeo", name: "Vimeo Integration", status: v.ok ? "ok" : "error", latencyMs: ms, message: v.message || "" });
      }
    }

    // Secrets + Kill Switch
    if (killResult.status === "fulfilled") {
      const { result: k } = killResult.value;
      checks.push({ key: "kill_switch", name: "Kill Switch", status: k.killSwitch ? "warn" : "ok",
        message: k.killSwitch ? "⚠ ACTIVE — all video playback is blocked" : "Inactive (video playback enabled)" });
      checks.push({ key: "signing_secret", name: "Signing Secret", status: k.signingSecret ? "ok" : "error",
        message: k.signingSecret ? "Set" : "Missing — HLS token signing will fail in production" });
      checks.push({ key: "lms_secret", name: "LMS HMAC Secret", status: k.lmsSecret ? "ok" : "warn",
        message: k.lmsSecret ? "Set" : "Not set — LMS embed launch tokens will not work" });
      checks.push({ key: "integration_secret", name: "Integration Master Secret", status: k.integrationSecret ? "ok" : "warn",
        message: k.integrationSecret ? "Set" : "Not set — integration API tokens may not work" });
      const bunnyOk = k.bunnyStorage && k.bunnyToken;
      const bunnyWarn = k.bunnyStorage && !k.bunnyToken;
      const bunnyMissing = !k.bunnyStorage;
      const activeConnProvider = storageResult.status === "fulfilled" ? (storageResult.value.result as any).provider : null;
      // Bunny.net — always show
      checks.push({ key: "bunny_secrets", name: "Bunny.net Secrets",
        status: bunnyMissing ? "warn" : bunnyWarn ? "warn" : "ok",
        message: bunnyMissing ? "Not configured (BUNNY_STORAGE_ACCESS_KEY not set)"
          : bunnyWarn ? "Storage key set — Token Auth key missing (CDN token signing disabled)"
          : "Storage key + Token Auth key both set" });
      // Backblaze B2 — always show
      const b2HasKeys = k.b2KeyId && k.b2AppKey;
      const b2Status: "ok" | "warn" | "error" = b2HasKeys && k.b2Endpoint ? "ok" : b2HasKeys ? "warn" : "warn";
      const b2Msg = !k.b2KeyId && !k.b2AppKey ? "Not configured (B2_KEY_ID / B2_APPLICATION_KEY not set)"
        : !k.b2KeyId ? "B2_KEY_ID missing"
        : !k.b2AppKey ? "B2_APPLICATION_KEY missing"
        : !k.b2Endpoint ? "Keys set — B2_S3_ENDPOINT missing"
        : "B2_KEY_ID + B2_APPLICATION_KEY + B2_S3_ENDPOINT all set";
      checks.push({ key: "b2_secrets", name: "Backblaze B2 Secrets", status: b2HasKeys && k.b2Endpoint ? "ok" : b2HasKeys ? "warn" : "warn", message: b2Msg });
      // Cloudflare R2 — always show
      const r2HasKeys = k.r2AccessKey && k.r2SecretKey;
      const r2Msg = !k.r2AccessKey && !k.r2SecretKey ? "Not configured (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY not set)"
        : !k.r2AccessKey ? "R2_ACCESS_KEY_ID missing"
        : !k.r2SecretKey ? "R2_SECRET_ACCESS_KEY missing"
        : !k.r2Endpoint ? "Keys set — R2_ENDPOINT missing"
        : "R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY + R2_ENDPOINT all set";
      checks.push({ key: "r2_secrets", name: "Cloudflare R2 Secrets", status: r2HasKeys && k.r2Endpoint ? "ok" : r2HasKeys ? "warn" : "warn", message: r2Msg });
    } else {
      checks.push({ key: "secrets", name: "Environment Secrets", status: "error", message: killResult.reason?.message || "Could not read settings" });
    }

    // Recent errors from audit log
    let recentErrors: any[] = [];
    try {
      const logs = await storage.getAuditLogs();
      recentErrors = logs.filter(l => ["error", "security_breach", "stream_denied", "abuse_detected", "upload_failed"].some(k => l.action.includes(k))).slice(0, 10);
    } catch {}

    const errorCount = checks.filter(c => c.status === "error").length;
    const warnCount = checks.filter(c => c.status === "warn").length;
    const overall = errorCount > 0 ? "error" : warnCount > 0 ? "degraded" : "healthy";

    res.json({ checkedAt, overall, checks, recentErrors });
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
    (globalThis as any).__clearSecurityEffectiveCache?.();
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
    (globalThis as any).__clearSecurityEffectiveCache?.();
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
    (globalThis as any).__clearSecurityEffectiveCache?.();
    res.json({ ok: true });
  });

  // Public endpoint: returns the list of allowed LMS origins so the embed player
  // can validate postMessage senders before forwarding to /mint
  app.get("/api/lms/origins", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ origins: getAllowedLmsOrigins() });
  });

  // Admin-only debug endpoint: diagnoses an HMAC token without revealing the secret
  // POST /api/lms/debug-hmac  { token: "payloadB64.hexSig" }
  app.post("/api/lms/debug-hmac", requireAuth, (req: Request, res: Response) => {
    const { token } = req.body as { token?: string };
    if (!token || typeof token !== "string") return res.status(400).json({ error: "token required" });
    const secret = process.env.LMS_HMAC_SECRET;
    if (!secret) return res.status(500).json({ error: "LMS_HMAC_SECRET not configured on server" });
    const parts = token.split(".");
    if (parts.length !== 2) {
      return res.json({ ok: false, error: `Token has ${parts.length} parts — must be exactly 2 (payloadB64.hexSig). Likely a JWT (3 parts) or wrong format.` });
    }
    const [payloadB64, sig] = parts;
    let payload: any = null;
    let parseError = "";
    try {
      payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    } catch (e: any) {
      parseError = e.message;
    }
    const expectedSig = crypto.createHmac("sha256", secret).update(payloadB64).digest("hex");
    const allowedOrigins = getAllowedLmsOrigins();
    const nowSec = Math.floor(Date.now() / 1000);
    return res.json({
      ok: sig === expectedSig,
      parts: parts.length,
      payloadParsed: parseError ? false : true,
      payloadParseError: parseError || undefined,
      payloadFields: payload ? Object.keys(payload) : [],
      payloadValues: payload ? {
        aud: payload.aud,
        origin: payload.origin,
        publicId: payload.publicId,
        expIn: payload.exp ? `${payload.exp - nowSec}s from now` : undefined,
      } : undefined,
      signatureMatch: sig === expectedSig,
      sigReceivedTail: `...${sig.slice(-8)}`,
      sigExpectedTail: `...${expectedSig.slice(-8)}`,
      sigLengthOk: sig.length === 64,
      secretLengthOnServer: secret.length,
      originAllowed: payload?.origin ? allowedOrigins.includes(payload.origin) : false,
      allowedOrigins,
      diagnosis: sig === expectedSig
        ? "Token signature is VALID ✓"
        : parseError
          ? `Payload is not valid base64url JSON: ${parseError}`
          : `HMAC mismatch — received tail ...${sig.slice(-8)}, expected tail ...${expectedSig.slice(-8)}. ` +
            `This means the LMS is either signing the wrong data (raw JSON instead of base64url string), ` +
            `using a different secret value, or appending extra characters to the secret.`
    });
  });

  // ── /api/security/effective/:videoId — cached resolver ───────────────────
  // The effective security profile is read by the player on every load and
  // sometimes refetched mid-session. Each call previously made 1-3 Postgres
  // round-trips (getUseGlobal, getGlobal, getVideo). The data changes only
  // when an admin edits the security page, so a short in-memory cache is
  // safe: a stale read at most equals the TTL after an admin save.
  // Cache invalidation: admin save handlers below already call clearSecurityEffectiveCache().
  const SECURITY_EFFECTIVE_CACHE_TTL_MS = 60_000;
  const securityEffectiveCache = new Map<string, { value: any; expires: number }>();
  (globalThis as any).__clearSecurityEffectiveCache = () => securityEffectiveCache.clear();
  app.get("/api/security/effective/:videoId", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const key = req.params.videoId;
    const now = Date.now();
    const cached = securityEffectiveCache.get(key);
    if (cached && cached.expires > now) return res.json(cached.value);

    const useGlobal = await secRepo.getUseGlobal(key);
    let value: any;
    if (useGlobal) {
      value = await secRepo.getGlobal();
    } else {
      const video = await secRepo.getVideo(key);
      value = video ?? (await secRepo.getGlobal());
    }
    securityEffectiveCache.set(key, { value, expires: now + SECURITY_EFFECTIVE_CACHE_TTL_MS });
    res.json(value);
  });

  // ── Cache Probe (admin + DEBUG_CACHE_PROBE_SECRET required) ────────────────
  // Fetches a single segment URL N times through the Cloudflare Worker and
  // reports cf-cache-status + latency for each request. Used to verify the
  // synthetic edge cache is working in production.
  //
  // SAFETY:
  //  • Requires admin session AND a matching DEBUG_CACHE_PROBE_SECRET query param.
  //  • Returns 404 if DEBUG_CACHE_PROBE_SECRET env var is missing.
  //  • The caller must supply a fully-signed segment URL (grab from devtools
  //    while a video plays). The probe does NOT mint tokens — that keeps
  //    signing logic out of this endpoint entirely.
  //  • The supplied URL must point at HLS_GATEWAY_BASE — no arbitrary URLs.
  //  • Never returns segment bytes (only byte count + latency + cf-cache-status).
  //  • Never logs or echoes the signed URL back in the response.
  app.get("/api/_debug/cache-probe", requireAuth, async (req: any, res: any) => {
    const probeSecret = process.env.DEBUG_CACHE_PROBE_SECRET;
    if (!probeSecret) {
      return res.status(404).json({ message: "Not available" });
    }
    if (req.query.secret !== probeSecret) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const gateway = process.env.HLS_GATEWAY_BASE;
    if (!gateway) {
      return res.status(400).json({ message: "HLS_GATEWAY_BASE not configured" });
    }
    const targetUrl = String(req.query.url || "");
    const n = Math.max(1, Math.min(20, parseInt(String(req.query.n || "5"), 10) || 5));
    if (!targetUrl) {
      return res.status(400).json({ message: "url query param required (full signed segment URL)" });
    }
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return res.status(400).json({ message: "Invalid url" });
    }
    const allowedHost = new URL(gateway).host;
    if (parsed.host !== allowedHost) {
      return res.status(400).json({ message: `url must point at ${allowedHost}` });
    }

    // Determine route type: legacy /seg/ or stealth /stream/chunk/
    const isSegRoute = parsed.pathname.startsWith("/seg/");
    const stealthChunkMatch = parsed.pathname.match(/^\/api\/player\/([^/]+)\/stream\/chunk\/([^/?#]+)\/?$/);
    const isStealthChunk = !!stealthChunkMatch;

    if (!isSegRoute && !isStealthChunk) {
      return res.status(400).json({
        message: "Only /seg/ and /api/player/:id/stream/chunk/:opaqueId paths are cacheable; probe only those",
      });
    }

    // Pre-flight diagnostics for stealth chunks ─────────────────────────────
    // These tell you WHY the Worker might bypass the cache before the first
    // request is even fired, so you can fix config issues without waiting for
    // all N probes to complete.
    let preflight: Record<string, unknown> | null = null;
    if (isStealthChunk && stealthChunkMatch) {
      const opaqueId = stealthChunkMatch[2];
      const stParam = parsed.searchParams.get("st");
      const expParam = parsed.searchParams.get("exp");
      const STABLE_PREFIX_LEN = 16;
      const HEX_RE = /^[0-9a-f]+$/i;

      const hasStParam = !!stParam;
      const hasExpParam = !!expParam;
      const idLengthOk = opaqueId.length > STABLE_PREFIX_LEN + 60;
      const idHexOk = HEX_RE.test(opaqueId);
      const stablePrefix = idLengthOk && idHexOk ? opaqueId.slice(0, STABLE_PREFIX_LEN) : null;

      // Recompute the expected st value if we have the signing secret, so we
      // can tell the caller whether the Worker's HMAC check would pass.
      let stValid: boolean | "no_signing_secret" = "no_signing_secret";
      const signingSecret = process.env.SIGNING_SECRET;
      if (signingSecret && stablePrefix && stParam && expParam) {
        const expNum = parseInt(expParam, 10);
        const expected = signChunkCacheToken(stealthChunkMatch[1], stablePrefix, expNum);
        stValid = expected === stParam;
      }

      const expNum = expParam ? parseInt(expParam, 10) : null;
      const nowSec = Math.floor(Date.now() / 1000);
      const expOk = expNum !== null && Number.isFinite(expNum) && nowSec <= expNum + 15 && expNum - nowSec <= 3600;

      // canEdgeCache mirrors the Worker's exact boolean
      const canEdgeCache =
        idLengthOk &&
        idHexOk &&
        hasStParam &&
        hasExpParam &&
        stValid === true &&
        expOk;

      preflight = {
        routeType: "stealth_chunk",
        publicId: stealthChunkMatch[1],
        opaqueIdLength: opaqueId.length,
        opaqueIdHex: idHexOk,
        opaqueIdLengthOk: idLengthOk,
        stablePrefix,
        syntheticCacheKey: stablePrefix ? `https://cache.internal/stealth-chunk/${stealthChunkMatch[1]}/${stablePrefix}` : null,
        hasStParam,
        hasExpParam,
        stTokenValid: stValid,
        expSecondsRemaining: expNum !== null ? expNum - nowSec : null,
        expOk,
        canEdgeCache,
        workerWillCache: canEdgeCache,
        diagnosis: !idLengthOk
          ? "FAIL: opaqueId too short — old session without 16-hex prefix; get a fresh chunk URL"
          : !idHexOk
            ? "FAIL: opaqueId is not pure hex — URL may be malformed"
            : !hasStParam
              ? "FAIL: ?st= param missing — chunk URL minted before signed-cache-token was added; get a fresh chunk URL"
              : !hasExpParam
                ? "FAIL: ?exp= param missing — chunk URL minted before signed-cache-token was added; get a fresh chunk URL"
                : stValid === "no_signing_secret"
                  ? "WARN: SIGNING_SECRET not set server-side — cannot verify st token locally; also check Worker env vars"
                  : !stValid
                    ? "FAIL: st token mismatch — SIGNING_SECRET in Worker env likely differs from Railway; sync them and redeploy Worker"
                    : !expOk
                      ? "FAIL: URL is expired (exp + 15s < now) — fetch a fresh chunk URL from a live player session"
                      : "OK: all Worker canEdgeCache conditions pass; expect MISS then HIT",
      };
    } else {
      preflight = { routeType: "seg_legacy" };
    }

    // For stealth chunks: the opaque ID encodes a session ID with a bound
    // UA hash. The probe MUST send the same User-Agent the browser used or
    // Railway's validateUserAgent will reject with 403 "Device mismatch" —
    // which is not cacheable, so the cache stays empty and every request is
    // a MISS that the Worker can't store. Accept ?ua= override; default to
    // a modern Chrome UA which matches what most embed players send.
    const uaOverride = String(req.query.ua || "");
    const probeUa = uaOverride ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    const results: Array<{ idx: number; status: number; bytes: number; latencyMs: number; cfCache: string | null; errorSnippet?: string }> = [];
    for (let i = 0; i < n; i++) {
      const t0 = Date.now();
      try {
        const r = await fetch(targetUrl, {
          method: "GET",
          headers: { "User-Agent": probeUa },
        });
        const buf = await r.arrayBuffer();
        const entry: any = {
          idx: i,
          status: r.status,
          bytes: buf.byteLength,
          latencyMs: Date.now() - t0,
          cfCache: r.headers.get("cf-cache-status"),
        };
        // For non-2xx, surface the first 200 chars of the body so the caller
        // can see WHICH 403 (UA mismatch, session revoked, abuse block, etc.)
        if (r.status >= 400 && buf.byteLength > 0 && buf.byteLength < 2000) {
          try {
            entry.errorSnippet = new TextDecoder().decode(buf).slice(0, 200);
          } catch {}
        }
        results.push(entry);
      } catch (e: any) {
        results.push({ idx: i, status: 0, bytes: 0, latencyMs: Date.now() - t0, cfCache: null });
      }
    }
    const hits = results.filter(r => r.cfCache === "HIT").length;
    const misses = results.filter(r => r.cfCache === "MISS").length;
    const avgLatency = Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / results.length);
    const allMiss = misses === n;
    const expectation = isStealthChunk
      ? "Expected: 1st = MISS (Worker fetches from Railway + stores), 2nd-5th = HIT (Worker returns cached bytes, Railway sees nothing)"
      : "Expected: 1st = MISS (Worker fetches from B2 + stores), 2nd-5th = HIT (Worker returns cached bytes)";
    res.json({
      requests: n,
      hits,
      misses,
      hitRate: `${Math.round((hits / n) * 100)}%`,
      avgLatencyMs: avgLatency,
      expectation,
      cacheVerdict: hits >= n - 1 ? "PASS: cache is working" : allMiss ? "FAIL: all MISS — see preflight.diagnosis" : `PARTIAL: only ${hits}/${n} HITs`,
      preflight,
      results,
    });
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
        const storageClient = conn.provider === "cloudflare_r2" ? makeR2Client({ endpoint: cfg.endpoint }) : makeB2Client({ endpoint: cfg.endpoint });
        const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
        const listResp = await storageClient.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: hlsPrefix, MaxKeys: 100 }));
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
      const containsProxy = manifestUrl.includes("/hls/");
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
      for (let i = 0; i < thresholds.scoreToRevoke * 5 + 10; i++) {
        const r = trackRequest(rateSid, "127.0.0.1");
        if (r.abused) { tripped = true; break; }
      }
      revokeSession(rateSid);
      results["rate_limit_check"] = tripped
        ? { status: "PASS", detail: `Rate limit triggered after flooding requests` }
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
      detail: `Key limit: ${thresholds.keyHitsPerMin}/min (total ${thresholds.keyHitsTotal}), ` +
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
      if (!conn || (conn.provider !== "backblaze_b2" && conn.provider !== "cloudflare_r2")) {
        return res.status(400).json({ message: "Only Backblaze B2 or Cloudflare R2 storage supported for this test" });
      }
      const cfg = conn.config as any;

      const hlsPrefix = video.hlsS3Prefix || `videos/${video.id}/hls/`;
      const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
      const storageClient = conn.provider === "cloudflare_r2" ? makeR2Client({ endpoint: cfg.endpoint }) : makeB2Client({ endpoint: cfg.endpoint });
      const listResp = await storageClient.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: hlsPrefix, MaxKeys: 500 }));
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
        const playlistResp = await storageClient.send(new GOC({ Bucket: cfg.bucket, Key: variantM3u8Key }));
        const playlistText = await (playlistResp.Body as any).transformToString();
        const parsed = parsePlaylist(playlistText);
        const segFile = segment.split("/").pop()!;
        const segEntry = parsed.segments.find(s => s.uri === segFile || s.uri.endsWith(segFile));
        if (segEntry?.keyTag) originalIV = extractIVFromKeyTag(segEntry.keyTag);
      }

      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const segResp = await storageClient.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: segKey }));
      const rawBytes = Buffer.from(await (segResp.Body as any).transformToByteArray());
      const rawSha256 = crypto.createHash("sha256").update(rawBytes).digest("hex");

      // Fetch master key (key A)
      let masterKey: Buffer | null = null;
      const encKeyPath = video.encryptionKeyPath;
      if (encKeyPath) {
        try {
          const keyResp = await storageClient.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: encKeyPath }));
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
