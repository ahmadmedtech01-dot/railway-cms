import crypto from "crypto";

function resolveSecret(): string {
  const s = process.env.SIGNING_SECRET;
  if (!s) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SIGNING_SECRET env var is required. Generate one via GET /api/admin/generate-signing-secret and set it in Railway + Cloudflare Worker.");
    }
    console.warn("[video-session] WARNING: SIGNING_SECRET not set — using insecure dev-only key. Never deploy without it.");
    return "insecure-dev-only-signing-key";
  }
  return s;
}

const SECRET = resolveSecret();

const SESSION_MAX_AGE_MS = 60 * 60 * 1000;   // 60 min — covers long videos + pauses for 2k+ daily users
export const SESSION_ROTATION_MS = 3 * 60 * 1000;

const ABUSE_THRESHOLDS = {
  // Only used when suspiciousDetectionEnabled=true
  // Tuned to NEVER trigger on normal HLS playback (incl. seeks, quality switches,
  // reloads, hls.js cancel/retry bursts). Only sustained abuse should score.
  concurrentSegments: 24,          // hls.js may parallel-fetch on quality switch/seek (raised 10→24)
  segmentsPerSec: 50,              // raised 30→50 (per-sec rate; sustained 5s window still required)
  segmentRateSpikeWindowMs: 5000,
  playlistPerSec: 2,
  playlistSpikeWindowMs: 8000,
  keyHitsPerMin: 120,              // VOD seeking re-fetches key heavily (raised 60→120)
  keyHitsTotal: 400,               // raised for long lectures with many seeks (200→400)
  scoreToRevoke: 30,               // raised 20→30 — only real abuse stacks this high
  windowSize: 60,                  // ±60 segments ≈ ±2 min @ 2s/seg (raised 20→60)
  outOfWindowPenalty: 0,           // single OOW no longer scores abuse — only sustained pattern does
  outOfWindowGrace: 12,            // first N out-of-window denials are silent (no abuse score)
  outOfWindowSustainedWindowMs: 60_000,
  outOfWindowSustainedCount: 30,   // only score if >30 OOW in 60s (clear scraper pattern)
};

const TOKEN_TTL = {
  manifest: 3600,
  playlist: 3600,
  // VOD: full playlist is served at once with all segment URLs embedded.
  // 3600s (60 min) matches SESSION_MAX_AGE_MS so signed URLs never expire
  // before the session does — no mid-watch expiry for 2k+ daily users.
  segment: 3600,
  key: 3600,
};

export interface AbuseReason {
  signal: "rate_limit" | "concurrent" | "playlist_abuse" | "key_abuse" | "ip_mismatch" | "out_of_window" | "bulk_download" | "velocity_abuse" | "hook_detected" | "heartbeat_invalid";
  detail: string;
}

export interface SessionHardeningConfig {
  mediaSourceGuardEnabled: boolean;
  velocityScoringEnabled: boolean;
  keyBindingEnabled: boolean;
  heartbeatV2Enabled: boolean;
  serverGatedWindowEnabled: boolean;
  shortTokenTtlEnabled: boolean;
  tokenTtlPlaylistSec: number;
  tokenTtlSegmentSec: number;
  tokenTtlKeySec: number;
  heartbeatIntervalSec: number;
  downloadAheadLimit: number;
  stealthModeEnabled: boolean;
}

export const defaultHardening: SessionHardeningConfig = {
  mediaSourceGuardEnabled: true,
  velocityScoringEnabled: true,
  keyBindingEnabled: true,
  heartbeatV2Enabled: true,
  serverGatedWindowEnabled: true,
  shortTokenTtlEnabled: true,
  tokenTtlPlaylistSec: 22,
  tokenTtlSegmentSec: 10,
  tokenTtlKeySec: 10,
  heartbeatIntervalSec: 12,
  // Allow hls.js to prefetch ~2 min ahead (60 segs @ 2s) without false abuse.
  // Real bulk-download scrapers request hundreds in seconds and still get caught
  // by velocity/segments-per-sec checks.
  downloadAheadLimit: 60,
  stealthModeEnabled: true,
};

// ── Stealth Mode opaque ID encoding ──────────────────────────────────────────
// Encrypts a small JSON payload with AES-256-GCM. Output is hex — no .m3u8,
// .ts, /key, seg_*, master, index visible in the URL. Server decodes to recover
// the real segment path / key reference and applies all standard checks.
const stealthAesKey = crypto
  .createHash("sha256")
  .update(SECRET + "::stealth-v1")
  .digest();

export type OpaqueKind = "l" | "c" | "k"; // level / chunk / key
export interface OpaquePayload {
  s: string;      // sid
  t: OpaqueKind;  // type
  v?: string;     // variant subpath (level: "720p/index.m3u8")
  p?: string;     // segment subpath (chunk: "720p/seg_000.ts")
  e: number;      // exp (unix seconds)
  n?: string;     // optional nonce
}

export function mintOpaqueId(payload: OpaquePayload): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", stealthAesKey, iv);
  const pt = Buffer.from(JSON.stringify(payload), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("hex");
}

export function verifyOpaqueId(id: string): OpaquePayload | null {
  try {
    if (typeof id !== "string" || id.length < 60 || !/^[0-9a-f]+$/i.test(id)) return null;
    const buf = Buffer.from(id, "hex");
    if (buf.length < 12 + 16 + 1) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(buf.length - 16);
    const ct = buf.subarray(12, buf.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", stealthAesKey, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    const parsed = JSON.parse(pt.toString("utf8")) as OpaquePayload;
    if (!parsed || typeof parsed.s !== "string" || typeof parsed.e !== "number") return null;
    if (parsed.t !== "l" && parsed.t !== "c" && parsed.t !== "k") return null;
    const now = Math.floor(Date.now() / 1000);
    if (parsed.e + 3 < now) return null; // 3s clock skew tolerance
    return parsed;
  } catch {
    return null;
  }
}

export interface ParsedSegment {
  extinf: string;
  uri: string;
  keyTag?: string;
}

export interface PlaylistCache {
  header: string;
  segments: ParsedSegment[];
  targetDuration: number;
}

export interface VideoSession {
  publicId: string;
  hlsPrefix: string;
  storageProvider: "backblaze_b2" | "cloudflare_r2" | "s3" | "local" | "bunny_net";
  storageConfig: any;
  connId: string | null;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
  revokeReason: AbuseReason | null;
  abuseScore: number;
  breachEvents: number;
  blockedUntil: number | null;
  requestLog: number[];
  concurrentSegments: number;
  playlistFetchLog: number[];
  keyHitLog: number[];
  segmentFetchLog: number[];
  boundIp: string | null;

  deviceHash: string;
  userAgentHash: string;
  currentSegmentIndex: number;
  lastProgressAt: number;
  outOfWindowCount: number;
  variantCache: Map<string, PlaylistCache>;

  ephemeralKey: Buffer;
  ephemeralIV: Buffer;

  keyIssued: boolean;
  keyIssuedCount: number;
  keyExp: number;
  keySig: string;

  // Whether suspicious-activity blocking is enabled for this session
  suspiciousDetectionEnabled: boolean;

  violationLimit: number;

  // Track spike detection: timestamp when rate first exceeded threshold
  segmentRateSpikeStart: number | null;
  playlistSpikeStart: number | null;

  // ── Hardening config (per-session snapshot) ──────────────────────────────
  hardening: SessionHardeningConfig;
  // Last heartbeat metadata for server-gated window + replay protection
  lastHeartbeatSeq: number;
  lastHeartbeatAt: number;
  lastHeartbeatNonces: string[]; // ring buffer (max 64)
  windowLastAdvancedAt: number;
  // Velocity scoring (segment fetches in last N seconds)
  velocityLog: number[];
  // Client-reported security events (counter for revocation thresholds)
  clientSecurityEvents: number;
  // Optional linkage to an Integration playback session row (LMS API flow)
  integrationSessionId?: string;
}

// ── Integration session revoke notifier ────────────────────────────────────
// Registered at startup by routes.ts to avoid circular imports with storage.
type IntegrationRevokeNotifier = (integrationSessionId: string, reason: string) => void;
let integrationRevokeNotifier: IntegrationRevokeNotifier | null = null;
export function setIntegrationRevokeNotifier(fn: IntegrationRevokeNotifier) {
  integrationRevokeNotifier = fn;
}

const sessions = new Map<string, VideoSession>();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    // Only delete if the session is truly expired. Removed the 30-min hard cap
    // on createdAt: heartbeat/extend bumps expiresAt up to SESSION_MAX_AGE_MS
    // (60 min) from each ping, so long lectures stayed alive but the GC was
    // killing them after 30 min anyway, causing forced re-auth + denial loops.
    if (now > s.expiresAt) sessions.delete(id);
  }
}, 60 * 1000).unref();

export function computeDeviceHash(ua: string): string {
  return crypto.createHash("sha256").update(ua || "unknown-ua").digest("hex").slice(0, 16);
}

export function createSession(
  publicId: string,
  hlsPrefix: string,
  storageProvider: "backblaze_b2" | "cloudflare_r2" | "s3" | "local" | "bunny_net",
  storageConfig: any,
  connId: string | null,
  deviceHash?: string,
  userAgent?: string,
  suspiciousDetectionEnabled = true,
  violationLimit = DEFAULT_VIOLATION_LIMIT,
  hardening: SessionHardeningConfig = defaultHardening,
): string {
  const sid = crypto.randomBytes(16).toString("hex");
  const uaHash = userAgent ? crypto.createHash("sha256").update(userAgent).digest("hex").slice(0, 32) : "";
  const keyExp = Math.floor(Date.now() / 1000) + Math.floor(SESSION_MAX_AGE_MS / 1000);
  const keySig = signPath(sid, "/key", keyExp);
  sessions.set(sid, {
    publicId,
    hlsPrefix,
    storageProvider,
    storageConfig,
    connId,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_MAX_AGE_MS,
    revoked: false,
    revokeReason: null,
    abuseScore: 0,
    breachEvents: 0,
    blockedUntil: null,
    requestLog: [],
    concurrentSegments: 0,
    playlistFetchLog: [],
    keyHitLog: [],
    segmentFetchLog: [],
    boundIp: null,
    deviceHash: deviceHash || "",
    userAgentHash: uaHash,
    currentSegmentIndex: 0,
    lastProgressAt: Date.now(),
    outOfWindowCount: 0,
    variantCache: new Map(),
    ephemeralKey: crypto.randomBytes(16),
    ephemeralIV: crypto.randomBytes(16),
    keyIssued: false,
    keyIssuedCount: 0,
    keyExp,
    keySig,
    suspiciousDetectionEnabled,
    violationLimit,
    segmentRateSpikeStart: null,
    playlistSpikeStart: null,
    hardening,
    lastHeartbeatSeq: 0,
    lastHeartbeatAt: Date.now(),
    lastHeartbeatNonces: [],
    windowLastAdvancedAt: Date.now(),
    velocityLog: [],
    clientSecurityEvents: 0,
    integrationSessionId: undefined,
  });
  return sid;
}

export function setIntegrationSessionId(sid: string, integrationSessionId: string): boolean {
  const s = sessions.get(sid);
  if (!s) return false;
  s.integrationSessionId = integrationSessionId;
  return true;
}

export function revokeSessionsByIntegrationId(integrationSessionId: string, reason?: AbuseReason): number {
  let count = 0;
  for (const s of sessions.values()) {
    if (s.integrationSessionId === integrationSessionId && !s.revoked) {
      s.revoked = true;
      if (reason) s.revokeReason = reason;
      count++;
    }
  }
  return count;
}

export function rotateSession(oldSid: string): string | null {
  const old = sessions.get(oldSid);
  if (!old || old.revoked) return null;

  const newSid = crypto.randomBytes(16).toString("hex");
  const keyExp = Math.floor(Date.now() / 1000) + Math.floor(SESSION_MAX_AGE_MS / 1000);
  const keySig = signPath(newSid, "/key", keyExp);

  sessions.set(newSid, {
    ...old,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_MAX_AGE_MS,
    revoked: false,
    revokeReason: null,
    abuseScore: 0,
    breachEvents: 0,
    blockedUntil: null,
    requestLog: [],
    playlistFetchLog: [],
    keyHitLog: [],
    segmentFetchLog: [],
    concurrentSegments: 0,
    outOfWindowCount: 0,
    variantCache: new Map(),
    ephemeralKey: crypto.randomBytes(16),
    ephemeralIV: crypto.randomBytes(16),
    keyIssued: false,
    keyIssuedCount: 0,
    keyExp,
    keySig,
    segmentRateSpikeStart: null,
    playlistSpikeStart: null,
    lastHeartbeatSeq: 0,
    lastHeartbeatAt: Date.now(),
    lastHeartbeatNonces: [],
    windowLastAdvancedAt: Date.now(),
    velocityLog: [],
    clientSecurityEvents: 0,
  });

  old.revoked = true;
  old.revokeReason = { signal: "rate_limit", detail: "Session rotated" };

  console.log(`[video-session] SESSION_ROTATED: oldSid=${oldSid} → newSid=${newSid}, publicId=${old.publicId}`);
  return newSid;
}

/**
 * Extend an existing session's TTL without creating a new SID.
 * Used by the heartbeat endpoint so the player never needs to call
 * hls.loadSource() during normal playback — eliminating the 1-2s black
 * screen that a full session rotation causes by flushing the MSE buffer.
 */
export function extendSession(sid: string): boolean {
  const s = sessions.get(sid);
  if (!s || s.revoked) return false;
  s.expiresAt = Date.now() + SESSION_MAX_AGE_MS;
  console.log(`[video-session] SESSION_EXTENDED: sid=${sid}, publicId=${s.publicId}, newExpiry=${new Date(s.expiresAt).toISOString()}`);
  return true;
}

export function getSession(sid: string): VideoSession | undefined {
  const s = sessions.get(sid);
  if (!s) return undefined;
  if (Date.now() > s.expiresAt) {
    s.revoked = true;
    s.revokeReason = { signal: "rate_limit", detail: "Session expired" };
    return s;
  }
  return s;
}

export function revokeSession(sid: string, reason?: AbuseReason): void {
  const s = sessions.get(sid);
  if (s) {
    s.revoked = true;
    if (reason) s.revokeReason = reason;
    // Propagate to integration session row (LMS API flow)
    if (s.integrationSessionId && integrationRevokeNotifier) {
      try {
        integrationRevokeNotifier(s.integrationSessionId, reason?.detail || reason?.signal || "abuse_revoked");
      } catch (e) {
        console.error("[video-session] integration revoke notifier failed:", e);
      }
    }
  }
}

export function validateUserAgent(sid: string, userAgent: string): boolean {
  const s = sessions.get(sid);
  if (!s || !s.userAgentHash) return true;
  const hash = crypto.createHash("sha256").update(userAgent || "").digest("hex").slice(0, 32);
  return hash === s.userAgentHash;
}

export function signPath(sid: string, resourcePath: string, exp: number, deviceHash?: string): string {
  let payload = `${sid}|${resourcePath}|${exp}`;
  if (deviceHash) payload += `|${deviceHash}`;
  return crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
}

export function verifySignedPath(sid: string, resourcePath: string, exp: number, st: string, deviceHash?: string, clockSkewSec?: number): boolean {
  const tolerance = clockSkewSec ?? 0;
  if (Math.floor(Date.now() / 1000) > exp + tolerance) return false;
  const expected = signPath(sid, resourcePath, exp, deviceHash);
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(st, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

const DEFAULT_VIOLATION_LIMIT = 10;
const BLOCK_DURATION_MS = 10 * 60 * 1000;

function addAbuse(s: VideoSession, delta: number, reason: AbuseReason): { abused: boolean } {
  if (!s.suspiciousDetectionEnabled) return { abused: false };

  s.abuseScore += delta;
  s.breachEvents += 1;

  if (s.breachEvents >= s.violationLimit || s.abuseScore >= ABUSE_THRESHOLDS.scoreToRevoke) {
    s.revoked = true;
    s.blockedUntil = Date.now() + BLOCK_DURATION_MS;
    if (!s.revokeReason) s.revokeReason = reason;
    console.log(`[video-session] SECURITY_BLOCK_REASON: ${reason.signal} — ${reason.detail} | publicId=${s.publicId}`);
    return { abused: true };
  }
  return { abused: false };
}

/**
 * Validates session is alive and checks IP binding.
 * Only does suspicious-activity rate checks when suspiciousDetectionEnabled=true.
 * Always enforces: session expiry, IP binding (for proxy/scraping detection), UA binding.
 */
export function trackRequest(sid: string, ip?: string): { abused: boolean; reason?: AbuseReason } {
  const s = sessions.get(sid);
  if (!s) return { abused: true, reason: { signal: "rate_limit", detail: "Session not found" } };
  if (s.revoked) return { abused: true, reason: s.revokeReason ?? { signal: "rate_limit", detail: "Session revoked" } };

  if (Date.now() > s.expiresAt) {
    s.revoked = true;
    return { abused: true, reason: { signal: "rate_limit", detail: "Session expired" } };
  }

  // IP tracking (informational only) — not enforced because playlist requests arrive
  // via the Cloudflare Worker (worker IP) while segments come directly from the browser
  // (browser IP), causing false ip_mismatch revocations. Session is already authenticated
  // by SID + HMAC signature + device-hash, so IP binding adds no meaningful security here.
  if (ip && !s.boundIp) {
    s.boundIp = ip;
  }

  return { abused: false };
}

export function trackPlaylistFetch(sid: string, ip?: string): { abused: boolean; reason?: AbuseReason } {
  const base = trackRequest(sid, ip);
  if (base.abused) return base;

  const s = sessions.get(sid)!;

  // When suspicious detection is disabled, skip rate-based checks
  if (!s.suspiciousDetectionEnabled) return { abused: false };

  const now = Date.now();

  // Grace window: skip playlist rate-counting for the first 10 seconds after
  // session creation so that normal reloads don't trigger abuse detection.
  if (now - s.createdAt < 10_000) return { abused: false };

  // Keep playlist fetches in a 5-second window
  s.playlistFetchLog = s.playlistFetchLog.filter(t => t > now - 5000);
  s.playlistFetchLog.push(now);

  // Signal: playlist fetch rate > 1/sec sustained for 5 seconds
  // 1/sec × 5 seconds = 5 fetches in 5s window
  if (s.playlistFetchLog.length > 5) {
    if (!s.playlistSpikeStart) {
      s.playlistSpikeStart = now;
    } else if (now - s.playlistSpikeStart >= ABUSE_THRESHOLDS.playlistSpikeWindowMs) {
      const reason: AbuseReason = {
        signal: "playlist_abuse",
        detail: `${s.playlistFetchLog.length} playlist fetches in 5s (sustained scraping) | publicId=${s.publicId}`,
      };
      console.log(`[video-session] SECURITY_BLOCK_REASON: PLAYLIST_SPAM | sid=${sid} fetches_5s=${s.playlistFetchLog.length}`);
      return addAbuse(s, 5, reason);
    }
  } else {
    s.playlistSpikeStart = null;
  }

  return { abused: false };
}

export function acquireSegment(sid: string, ip?: string): { abused: boolean; reason?: AbuseReason } {
  const base = trackRequest(sid, ip);
  if (base.abused) return base;

  const s = sessions.get(sid)!;
  s.concurrentSegments += 1;

  // When suspicious detection is disabled, allow all concurrent downloads
  if (!s.suspiciousDetectionEnabled) return { abused: false };

  // Signal: concurrent parallel segment downloads > 3 at the same moment
  if (s.concurrentSegments > ABUSE_THRESHOLDS.concurrentSegments) {
    const reason: AbuseReason = {
      signal: "concurrent",
      detail: `${s.concurrentSegments} concurrent segment requests (limit: ${ABUSE_THRESHOLDS.concurrentSegments})`,
    };
    s.concurrentSegments -= 1;
    console.log(`[video-session] SECURITY_BLOCK_REASON: CONCURRENT_SEGMENTS | sid=${sid} concurrent=${s.concurrentSegments + 1} publicId=${s.publicId}`);
    return addAbuse(s, 5, reason);
  }

  const now = Date.now();

  // NOTE: stale-heartbeat abuse scoring was removed from here.
  // Background tabs (mobile, minimized browser) get their JS timers throttled
  // by the browser — heartbeats arrive late even for 100% legitimate users.
  // When they return and hls.js fires 3+ parallel segment requests, every one
  // would have scored +3 abuse, revoking the session after 10 returns-from-bg.
  // The session TTL already handles truly abandoned sessions (they expire after
  // 60 min without a heartbeat). Real headless scrapers are caught by the
  // concurrent / velocity / rate-spike checks below.


  // Keep segment fetches in a 3-second window for rate spike detection
  s.segmentFetchLog = s.segmentFetchLog.filter(t => t > now - 3000);
  s.segmentFetchLog.push(now);

  // Signal: > 15 segments/sec sustained for 3 seconds = 45 fetches in 3s window
  if (s.segmentFetchLog.length > ABUSE_THRESHOLDS.segmentsPerSec * 3) {
    if (!s.segmentRateSpikeStart) {
      s.segmentRateSpikeStart = now;
    } else if (now - s.segmentRateSpikeStart >= ABUSE_THRESHOLDS.segmentRateSpikeWindowMs) {
      const reason: AbuseReason = {
        signal: "bulk_download",
        detail: `${s.segmentFetchLog.length} segments in 3s — RATE_SPIKE bulk download | publicId=${s.publicId}`,
      };
      console.log(`[video-session] SECURITY_BLOCK_REASON: RATE_SPIKE | sid=${sid} segments_3s=${s.segmentFetchLog.length}`);
      return addAbuse(s, 8, reason);
    }
  } else {
    s.segmentRateSpikeStart = null;
  }

  return { abused: false };
}

export function releaseSegment(sid: string): void {
  const s = sessions.get(sid);
  if (s && s.concurrentSegments > 0) s.concurrentSegments -= 1;
}

export function trackKeyHit(sid: string, ip?: string): { abused: boolean; reason?: AbuseReason } {
  const base = trackRequest(sid, ip);
  if (base.abused) return base;

  const s = sessions.get(sid)!;

  const now = Date.now();
  s.keyHitLog = s.keyHitLog.filter(t => t > now - 60000);
  s.keyHitLog.push(now);
  s.keyIssuedCount += 1;

  // Skip rate-based key checks when suspicious detection is disabled (e.g. admin preview)
  if (!s.suspiciousDetectionEnabled) return { abused: false };

  if (s.keyHitLog.length > ABUSE_THRESHOLDS.keyHitsPerMin) {
    const reason: AbuseReason = {
      signal: "key_abuse",
      detail: `${s.keyHitLog.length} key requests in 60s (limit: ${ABUSE_THRESHOLDS.keyHitsPerMin}) — KEY_SPAM | publicId=${s.publicId}`,
    };
    console.log(`[video-session] SECURITY_BLOCK_REASON: KEY_SPAM | sid=${sid} hits_per_min=${s.keyHitLog.length}`);
    return addAbuse(s, 5, reason);
  }

  if (s.keyIssuedCount > ABUSE_THRESHOLDS.keyHitsTotal) {
    const reason: AbuseReason = {
      signal: "key_abuse",
      detail: `${s.keyIssuedCount} total key requests this session (limit: ${ABUSE_THRESHOLDS.keyHitsTotal}) — KEY_REPLAY | publicId=${s.publicId}`,
    };
    console.log(`[video-session] SECURITY_BLOCK_REASON: KEY_REPLAY | sid=${sid} total_issued=${s.keyIssuedCount}`);
    return addAbuse(s, 5, reason);
  }

  return { abused: false };
}

export function checkAndIssueKey(sid: string): { allowed: boolean; alreadyIssued: boolean } {
  const s = sessions.get(sid);
  if (!s) return { allowed: false, alreadyIssued: false };
  if (s.keyIssued) {
    console.log(`[video-session] SECURITY_KEY_REPLAY: sid=${sid}, keyIssuedCount=${s.keyIssuedCount} — repeated key request`);
    return { allowed: false, alreadyIssued: true };
  }
  s.keyIssued = true;
  s.keyIssuedCount = 1;
  return { allowed: true, alreadyIssued: false };
}

let _gatewayWarned = false;
export function getHlsGatewayBase(): string {
  const gw = (process.env.HLS_GATEWAY_BASE || "").trim().replace(/\/+$/, "");
  if (gw) return gw;
  if (process.env.NODE_ENV === "production" && !_gatewayWarned) {
    _gatewayWarned = true;
    console.warn("[hls] WARNING: HLS_GATEWAY_BASE not set in production — HLS URLs will use Railway origin instead of Cloudflare Worker gateway");
  }
  return "";
}

export function buildSignedProxyUrl(baseUrl: string, sid: string, resourcePath: string, ttlSeconds: number, deviceHash?: string): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const st = signPath(sid, resourcePath, exp, deviceHash);
  const gateway = getHlsGatewayBase();
  const fullUrl = `${gateway}${baseUrl}`;
  const sep = fullUrl.includes("?") ? "&" : "?";
  return `${fullUrl}${sep}sid=${encodeURIComponent(sid)}&st=${encodeURIComponent(st)}&exp=${exp}`;
}

export function buildStableKeyUrl(baseUrl: string, sid: string, session: VideoSession): string {
  const gateway = getHlsGatewayBase();
  const fullUrl = `${gateway}${baseUrl}`;
  const sep = fullUrl.includes("?") ? "&" : "?";
  return `${fullUrl}${sep}sid=${encodeURIComponent(sid)}&st=${encodeURIComponent(session.keySig)}&exp=${session.keyExp}`;
}

export function updateProgress(sid: string, segmentIndex: number): boolean {
  const s = sessions.get(sid);
  if (!s || s.revoked) return false;
  s.currentSegmentIndex = Math.max(0, segmentIndex);
  s.lastProgressAt = Date.now();
  return true;
}

export function getWindowRange(sid: string): { start: number; end: number } {
  const s = sessions.get(sid);
  if (!s) return { start: 0, end: ABUSE_THRESHOLDS.windowSize };
  const start = Math.max(0, s.currentSegmentIndex - 1);
  const end = s.currentSegmentIndex + ABUSE_THRESHOLDS.windowSize;
  return { start, end };
}

export function validateSegmentWindow(sid: string, segIndex: number): { allowed: boolean; reason?: AbuseReason } {
  const s = sessions.get(sid);
  if (!s) return { allowed: false, reason: { signal: "rate_limit", detail: "Session not found" } };
  if (s.revoked) return { allowed: false, reason: s.revokeReason ?? { signal: "rate_limit", detail: "Session revoked" } };

  // SERVER-GATED MODE: only the heartbeat endpoint advances currentSegmentIndex.
  // Reject any segment outside [start, end] window so playlist walking is blocked.
  // Lenient mode: deny out-of-window requests but DO NOT score abuse for normal
  // hls.js prefetch / seek / quality-switch bursts. Only sustained out-of-window
  // patterns (clear scraper behaviour) score abuse points.
  if (s.hardening.serverGatedWindowEnabled) {
    // Widen the upstream window so seeks + buffer prefetch don't constantly trip it.
    const start = Math.max(0, s.currentSegmentIndex - 5);
    const end = s.currentSegmentIndex + Math.max(2, s.hardening.downloadAheadLimit);
    if (segIndex < start || segIndex > end) {
      s.outOfWindowCount += 1;

      // Track timing for sustained-pattern detection.
      const now = Date.now();
      (s as any)._oowLog = ((s as any)._oowLog || []).filter((t: number) => t > now - ABUSE_THRESHOLDS.outOfWindowSustainedWindowMs);
      (s as any)._oowLog.push(now);
      const oowInWindow: number = (s as any)._oowLog.length;

      const reason: AbuseReason = {
        signal: "out_of_window",
        detail: `seg=${segIndex} outside gated window [${start},${end}] (recent=${oowInWindow})`,
      };

      // Grace: first N out-of-window denials per session score 0 abuse points.
      if (s.outOfWindowCount <= ABUSE_THRESHOLDS.outOfWindowGrace) {
        return { allowed: false, reason };
      }

      // Sustained scraper pattern: only score if >outOfWindowSustainedCount in 60s
      if (oowInWindow >= ABUSE_THRESHOLDS.outOfWindowSustainedCount) {
        console.log(`[video-session] SECURITY_OUT_OF_WINDOW_SUSTAINED: sid=${sid} oowInWindow=${oowInWindow}`);
        addAbuse(s, 5, reason);
        return { allowed: false, reason };
      }

      // Soft deny — normal hls.js prefetch overshoot. No abuse score.
      return { allowed: false, reason };
    }
    return { allowed: true };
  }

  // Legacy mode: VOD allows any segment, auto-advance position tracker
  if (segIndex > s.currentSegmentIndex) {
    s.currentSegmentIndex = segIndex;
  }
  return { allowed: true };
}

// ── Velocity scoring — detects fast bulk fetches even if rate spike is sustained ───
// Returns abuse decision per segment fetch when velocityScoring is on.
export function trackSegmentVelocity(sid: string): { abused: boolean; reason?: AbuseReason } {
  const s = sessions.get(sid);
  if (!s || !s.hardening.velocityScoringEnabled || !s.suspiciousDetectionEnabled) return { abused: false };
  const now = Date.now();
  s.velocityLog = s.velocityLog.filter(t => t > now - 5000);
  s.velocityLog.push(now);
  // > downloadAheadLimit segments in 5 seconds = bulk download.
  // Now that downloadAheadLimit=60, this catches real scrapers (100+ segs in 5s)
  // without firing on quality-switch / seek bursts.
  if (s.velocityLog.length > s.hardening.downloadAheadLimit) {
    const reason: AbuseReason = {
      signal: "velocity_abuse",
      detail: `${s.velocityLog.length} segments in 5s exceeds downloadAheadLimit=${s.hardening.downloadAheadLimit} | publicId=${s.publicId}`,
    };
    console.log(`[video-session] SECURITY_VELOCITY_ABUSE: sid=${sid} segs_5s=${s.velocityLog.length} limit=${s.hardening.downloadAheadLimit}`);
    return addAbuse(s, 8, reason);
  }
  return { abused: false };
}

// ── Heartbeat verification — server-gated window only advances here ───────────
export interface HeartbeatInput {
  seq: number;
  nonce: string;
  currentTime: number;
  segmentIndex?: number;
}
export function verifyHeartbeat(sid: string, input: HeartbeatInput): { ok: boolean; reason?: string; windowStart?: number; windowEnd?: number; newSegmentIndex?: number } {
  const s = sessions.get(sid);
  if (!s || s.revoked) return { ok: false, reason: "session_invalid" };
  if (!Number.isFinite(input.seq) || input.seq <= 0) return { ok: false, reason: "bad_seq" };
  if (!input.nonce || typeof input.nonce !== "string" || input.nonce.length < 8 || input.nonce.length > 128) return { ok: false, reason: "bad_nonce" };
  if (!Number.isFinite(input.currentTime) || input.currentTime < 0) return { ok: false, reason: "bad_currentTime" };

  // Strict monotonic seq — defeats replay
  if (input.seq <= s.lastHeartbeatSeq) {
    addAbuse(s, 2, { signal: "heartbeat_invalid", detail: `seq regression ${input.seq} <= ${s.lastHeartbeatSeq}` });
    return { ok: false, reason: "seq_replay" };
  }
  if (s.lastHeartbeatNonces.includes(input.nonce)) {
    addAbuse(s, 2, { signal: "heartbeat_invalid", detail: `nonce replay ${input.nonce}` });
    return { ok: false, reason: "nonce_replay" };
  }
  // Ring buffer cap 64
  s.lastHeartbeatNonces.push(input.nonce);
  if (s.lastHeartbeatNonces.length > 64) s.lastHeartbeatNonces.shift();

  const now = Date.now();
  const elapsedSec = Math.max(0.5, (now - s.lastHeartbeatAt) / 1000);
  // Cap how fast playback time may advance between heartbeats — defeats heartbeat-forge walking
  const maxAdvanceSec = elapsedSec * 2.5 + 5; // generous: allow buffering catch-up + small skip
  const prevTime = s.currentSegmentIndex; // index proxy
  // (only enforced when server-gated window is on, since legacy mode is permissive)
  let advanceCappedSegIdx = input.segmentIndex;
  if (s.hardening.serverGatedWindowEnabled) {
    const anyCache = s.variantCache.values().next().value as PlaylistCache | undefined;
    const targetDur = anyCache?.targetDuration || 2;
    // Verify currentTime grew reasonably (allow seek backwards freely; cap forward advance)
    const segPerSec = 1 / targetDur;
    const maxSegAdvance = Math.ceil(maxAdvanceSec * segPerSec) + 2;
    const requestedSeg = typeof input.segmentIndex === "number" ? input.segmentIndex : Math.floor(input.currentTime / targetDur);
    const cappedSeg = Math.min(requestedSeg, s.currentSegmentIndex + maxSegAdvance);
    advanceCappedSegIdx = Math.max(0, cappedSeg);
    s.currentSegmentIndex = Math.max(s.currentSegmentIndex, advanceCappedSegIdx);
    // Allow backward seek (user scrubbing) — but reset window start
    if (requestedSeg < s.currentSegmentIndex - 10) {
      s.currentSegmentIndex = Math.max(0, requestedSeg);
    }
    s.windowLastAdvancedAt = now;
  }

  s.lastHeartbeatSeq = input.seq;
  s.lastHeartbeatAt = now;
  s.lastProgressAt = now;
  s.expiresAt = now + SESSION_MAX_AGE_MS;

  const { start, end } = getWindowRange(sid);
  return { ok: true, windowStart: start, windowEnd: end, newSegmentIndex: s.currentSegmentIndex };
}

// ── Client-reported security events (e.g. MediaSource hook detected) ──────────
export function recordSecurityEvent(sid: string, eventType: string): { revoked: boolean; score: number } {
  const s = sessions.get(sid);
  if (!s || s.revoked) return { revoked: true, score: 0 };
  s.clientSecurityEvents += 1;
  // High-severity events: revoke fast
  const highSeverity = new Set([
    "MEDIA_SOURCE_HOOK_DETECTED",
    "APPEND_BUFFER_HOOK_DETECTED",
    "HLS_BUFFER_CAPTURE_SUSPECTED",
  ]);
  if (highSeverity.has(eventType)) {
    const reason: AbuseReason = { signal: "hook_detected", detail: `client event=${eventType} publicId=${s.publicId}` };
    console.log(`[video-session] SECURITY_CLIENT_EVENT_HIGH: sid=${sid} event=${eventType}`);
    addAbuse(s, 10, reason); // score >= 10 triggers revoke (threshold=20 needs two; severe events alone bump breachEvents)
    s.revoked = true;
    s.blockedUntil = Date.now() + 10 * 60 * 1000;
    if (!s.revokeReason) s.revokeReason = reason;
    return { revoked: true, score: s.abuseScore };
  }
  const reason: AbuseReason = { signal: "hook_detected", detail: `client event=${eventType}` };
  console.log(`[video-session] SECURITY_CLIENT_EVENT: sid=${sid} event=${eventType}`);
  addAbuse(s, 2, reason);
  return { revoked: s.revoked, score: s.abuseScore };
}

// ── Per-session effective token TTL (short or default) ────────────────────────
export function getSessionTokenTTL(sid: string): { manifest: number; playlist: number; segment: number; key: number } {
  const s = sessions.get(sid);
  if (!s || !s.hardening.shortTokenTtlEnabled) return getTokenTTL();
  return {
    manifest: s.hardening.tokenTtlPlaylistSec,
    playlist: s.hardening.tokenTtlPlaylistSec,
    segment: s.hardening.tokenTtlSegmentSec,
    key: s.hardening.tokenTtlKeySec,
  };
}

export function parsePlaylist(playlistText: string): PlaylistCache {
  const lines = playlistText.split("\n");
  const headerLines: string[] = [];
  const segments: ParsedSegment[] = [];
  let targetDuration = 2;
  let inSegments = false;
  let pendingExtinf = "";
  let currentKeyTag = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "#EXT-X-ENDLIST") continue;

    if (trimmed.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = parseInt(trimmed.split(":")[1], 10) || 2;
    }

    if (trimmed.startsWith("#EXT-X-KEY:")) {
      currentKeyTag = trimmed;
      inSegments = true;
      continue;
    }

    if (trimmed.startsWith("#EXTINF:")) {
      inSegments = true;
      pendingExtinf = trimmed;
      continue;
    }

    if (pendingExtinf && trimmed && !trimmed.startsWith("#")) {
      segments.push({ extinf: pendingExtinf, uri: trimmed, keyTag: currentKeyTag || undefined });
      pendingExtinf = "";
      continue;
    }

    if (!inSegments) {
      if (trimmed && trimmed !== "#EXT-X-ENDLIST") {
        headerLines.push(trimmed);
      }
    }
    pendingExtinf = "";
  }

  const header = headerLines.filter(l => !l.startsWith("#EXT-X-MEDIA-SEQUENCE")).join("\n");
  return { header, segments, targetDuration };
}

export function getSessionAbuseSummary(sid: string) {
  const s = sessions.get(sid);
  if (!s) return null;
  return {
    sid,
    publicId: s.publicId,
    revoked: s.revoked,
    revokeReason: s.revokeReason,
    abuseScore: s.abuseScore,
    breachCount: s.breachEvents,
    violationLimit: s.violationLimit,
    blockedUntil: s.blockedUntil,
    concurrentSegments: s.concurrentSegments,
    recentRequests: s.requestLog.length,
    playlistFetches: s.playlistFetchLog.length,
    keyHits: s.keyHitLog.length,
    keyIssuedCount: s.keyIssuedCount,
    boundIp: s.boundIp,
    currentSegmentIndex: s.currentSegmentIndex,
    outOfWindowCount: s.outOfWindowCount,
    suspiciousDetectionEnabled: s.suspiciousDetectionEnabled,
  };
}

export function getBreachInfo(sid: string): { breachCount: number; violationLimit: number; blocked: boolean; blockSecondsRemaining: number } {
  const s = sessions.get(sid);
  // Unknown SID means the session was never created, already GC'd, or is from a
  // server restart. This is NOT a suspicious-activity block — the client should get
  // a recoverable "session not found" and retry, not see the abuse overlay.
  if (!s) return { breachCount: 0, violationLimit: DEFAULT_VIOLATION_LIMIT, blocked: false, blockSecondsRemaining: 0 };
  const remaining = s.blockedUntil ? Math.max(0, Math.ceil((s.blockedUntil - Date.now()) / 1000)) : 0;
  return { breachCount: s.breachEvents, violationLimit: s.violationLimit, blocked: s.revoked, blockSecondsRemaining: remaining };
}

export function getAbuseThresholds() {
  return { ...ABUSE_THRESHOLDS };
}

export function getTokenTTL() {
  return { ...TOKEN_TTL };
}

export function getAllSessions() {
  return Array.from(sessions.entries()).map(([sid, s]) => ({
    sid,
    publicId: s.publicId,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    revoked: s.revoked,
    abuseScore: s.abuseScore,
    concurrentSegments: s.concurrentSegments,
  }));
}
