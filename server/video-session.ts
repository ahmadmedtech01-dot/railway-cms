import crypto from "crypto";
import { db } from "./db";
import { videoSessions } from "../api/_lib/schema";
import { eq, lt, and } from "drizzle-orm";

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

// Optional, environment-gated verbose logging. The HLS hot path produces
// several log lines per segment (SEGMENT_PROXY, SESSION_EXTENDED) which at
// 2k+ concurrent students can block Node's synchronous stdout and degrade
// server throughput. Default OFF in production; set LOG_VERBOSE=1 to re-enable.
const LOG_VERBOSE = process.env.LOG_VERBOSE === "1" || process.env.NODE_ENV !== "production";
export function vlog(msg: string) { if (LOG_VERBOSE) console.log(msg); }

const ABUSE_THRESHOLDS = {
  // Only used when suspiciousDetectionEnabled=true
  // Tuned to NEVER trigger on normal HLS playback (incl. seeks, quality switches,
  // reloads, hls.js cancel/retry bursts). Only sustained abuse should score.
  // ── Concurrent segment cap ──────────────────────────────────────────────
  // Two caps: a "normal" cap and an "elevated" cap. The elevated cap kicks in
  // only when abuseScore is already at >= 50% of the violation limit — i.e.
  // some OTHER signal (velocity, playlist spam, key spam) already flagged this
  // session. This way legitimate hls.js bursts (initial buffer fill across
  // multiple quality levels, post-seek rebuffer) never trip the cap, but a
  // scraper that's already half-flagged gets clamped hard on the next wave.
  concurrentSegments: 64,          // raised 24→64; normal cap, rarely tripped
  concurrentSegmentsElevated: 8,   // clamps abuse-flagged sessions
  // TTL after which a stuck acquire is auto-released by the self-healing ring
  // below. Guarantees no leaked counter even if a code path forgets to call
  // releaseSegment() on an error branch.
  concurrentSegmentTtlMs: 15_000,
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
  // ── Security-profile tuning (time-based, admin-configurable) ─────────────
  // Used to scale abuse thresholds per-session so a single global preset
  // can serve 700-1000 concurrent students across different LMS network
  // conditions without false revocations or black screens.
  maxPrebufferSec: number;        // → ABUSE_THRESHOLDS.windowSize (segments)
  maxDownloadAheadSec: number;    // → velocity-scoring burst budget (sec/5s)
  windowOverlapGraceSec: number;  // → out-of-window grace (sec)
}

export const defaultHardening: SessionHardeningConfig = {
  mediaSourceGuardEnabled: true,
  velocityScoringEnabled: true,
  keyBindingEnabled: true,
  heartbeatV2Enabled: true,
  serverGatedWindowEnabled: true,
  shortTokenTtlEnabled: true,
  // TTLs raised from 22/10/10 → 90/90/90 to stop stealth chunk URLs from
  // expiring mid-playlist. The sliding-window playlist embeds ~60 chunk opaque
  // IDs all minted at the same instant. With a 10s TTL, segments deep in the
  // window expire long before hls.js reaches them (pause/seek/buffer-stall),
  // causing "Invalid chunk token" → hls.js fragment-retry storm → red XHRs →
  // video stops at ~10s. Real security is enforced by SID-binding, UA hash,
  // session lifetime, abuse detection, and window validation — not by token
  // TTL. 90s is well under SESSION_MAX_AGE_MS so signed URLs still rotate
  // through the natural session lifecycle.
  tokenTtlPlaylistSec: 60,
  tokenTtlSegmentSec: 30,
  tokenTtlKeySec: 30,
  // Heartbeat raised 15→30s. The heartbeat is pure session-keepalive — it
  // does not refresh any URL, signed token, or playlist. Halving its rate
  // cuts control-plane RPS without affecting playback, security, or
  // revocation latency (revocation chokepoint is /stream/window, polled
  // far more frequently). Matches the value already deployed in prod.
  heartbeatIntervalSec: 30,
  // Allow hls.js to prefetch without false abuse. Real bulk-download scrapers
  // request hundreds in seconds and still get caught by velocity checks.
  downloadAheadLimit: 30,
  stealthModeEnabled: true,
  // Balanced-profile defaults
  maxPrebufferSec: 45,
  maxDownloadAheadSec: 60,
  windowOverlapGraceSec: 30,
};

// ── Stealth Mode opaque ID encoding ──────────────────────────────────────────
// Encrypts a small JSON payload with AES-256-GCM. Output is hex — no .m3u8,
// .ts, /key, seg_*, master, index visible in the URL. Server decodes to recover
// the real segment path / key reference and applies all standard checks.
const stealthAesKey = crypto
  .createHash("sha256")
  .update(SECRET + "::stealth-v1")
  .digest();

export type OpaqueKind = "l" | "c" | "k" | "m"; // level / chunk / key / master
export interface OpaquePayload {
  s: string;      // sid
  t: OpaqueKind;  // type
  v?: string;     // variant subpath (level: "720p/index.m3u8")
  p?: string;     // segment subpath (chunk: "720p/seg_000.ts")
  e: number;      // exp (unix seconds)
  n?: string;     // optional nonce
}

// Deterministic IV derived from a keyed hash of the payload + a server-side
// secret. Two crucial properties:
//   1. Same payload  →  same IV  →  same ciphertext  →  same opaque URL.
//      This is what we want: the sliding-window playlist refetches every few
//      seconds and re-mints chunk/key URLs. With a random IV each mint produced
//      a different URL for the same segment, and hls.js would xhr.abort() the
//      in-flight load and re-request — the cancellation storm + 1-2s black
//      screen every ~30-45s the user reported. Deterministic IV makes the URL
//      stable across playlist reloads, so in-flight loads complete naturally.
//   2. Different payloads (different sid / path / exp) produce different IVs,
//      so the AES-GCM "never reuse (key, IV) for different plaintext" invariant
//      still holds. Safe under standard GCM threat model.
// The IV is also keyed by SECRET so it isn't predictable from the plaintext
// alone — an attacker can't pre-compute IV/ciphertext mappings without SECRET.
// Build a canonical byte representation of the payload with a FIXED field
// order. This is critical for AES-GCM safety: the deterministic IV is derived
// from this exact byte sequence, AND the same byte sequence is the plaintext.
// If we let callers' object-literal key order drift, two payloads with
// identical semantic values could produce the same IV but different plaintext
// bytes — a textbook AES-GCM nonce-reuse failure. Canonicalizing both inputs
// from the same source eliminates that risk by construction.
function canonicalizePayload(payload: OpaquePayload): Buffer {
  const canonical = {
    s: payload.s,
    t: payload.t,
    v: payload.v ?? "",
    p: payload.p ?? "",
    e: payload.e,
    n: payload.n ?? "",
  };
  return Buffer.from(JSON.stringify(canonical), "utf8");
}

function deriveDeterministicIv(canonicalBytes: Buffer): Buffer {
  return crypto
    .createHmac("sha256", SECRET + "::stealth-iv-v1")
    .update(canonicalBytes)
    .digest()
    .subarray(0, 12);
}

export function mintOpaqueId(payload: OpaquePayload): string {
  const pt = canonicalizePayload(payload);
  const iv = deriveDeterministicIv(pt);
  const cipher = crypto.createCipheriv("aes-256-gcm", stealthAesKey, iv);
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("hex");
}

// ── STABLE CHUNK CACHE-KEY PREFIX ─────────────────────────────────────────
// Length of the hex prefix prepended to chunk opaque IDs (16 hex = 8 bytes
// = 64 bits of HMAC entropy — enough to be collision-free per video and
// indistinguishable from random in the URL).
export const CHUNK_CACHE_PREFIX_LEN = 16;

// Deterministic stable cache key for a chunk. Same (publicId, segSubPath)
// always produces the same key — across users, sessions, even server
// restarts (HMAC keyed only by SIGNING_SECRET which is the same on every
// instance). Prefixed with "chunk|" domain separator so the same secret
// can't collide with any other HMAC use (e.g. /seg/ signing).
//
// SECURITY: publicId is INCLUDED in the HMAC. Without it, segSubPath like
// "720p/seg_042.ts" repeats across videos and Worker cache would serve
// Video A's bytes to Video B viewers. The publicId binding prevents that.
export function computeChunkStableKey(publicId: string, segSubPath: string): string {
  return crypto
    .createHmac("sha256", SECRET + "::stealth-chunk-cache-v1")
    .update(`chunk|${publicId}|${segSubPath}`)
    .digest("hex")
    .slice(0, CHUNK_CACHE_PREFIX_LEN);
}

// Mint a chunk opaque ID with a stable cache-key prefix prepended. The
// prefix is what the Cloudflare Worker reads to build its cache key —
// it's identical for all users watching the same segment, even though
// the encrypted suffix is per-session. The full ID stays URL-opaque.
//
// Format: <16hex stableKey><existing-opaque-hex>
//
// On the server, verifyOpaqueIdDetailed strips an optional 16-hex prefix
// before AES-GCM decryption, so this is backward-compatible with any
// old non-prefixed IDs that might still be in flight after a deploy.
export function mintOpaqueChunkId(payload: OpaquePayload, publicId: string): string {
  if (payload.t !== "c" || !payload.p) {
    // Only chunk opaque IDs get the prefix. For any other type, fall back
    // to the regular mint so callers using mintOpaqueChunkId mistakenly
    // can't accidentally pollute the cache namespace.
    return mintOpaqueId(payload);
  }
  const stable = computeChunkStableKey(publicId, payload.p);
  return stable + mintOpaqueId(payload);
}

// Edge-validatable signed token bound to (publicId, cache prefix, exp).
// The Cloudflare Worker uses this to authenticate stealth chunk URLs at
// the EDGE before doing a cache lookup. Without this, any holder of a
// previously-observed chunk URL could keep pulling bytes from the edge
// cache after their session is revoked — for up to the cache TTL (24h).
// With this gate, the replay window is bounded by `exp + skew` (~15s),
// matching the existing /seg/ revocation model.
//
// The signature is HMAC-SHA256 of "chunk-cache-v1|publicId|prefix|exp",
// keyed by SIGNING_SECRET. Both Worker and origin compute this the same
// way — the Worker has SIGNING_SECRET as an env var.
export function signChunkCacheToken(publicId: string, stablePrefix: string, exp: number): string {
  return crypto
    .createHmac("sha256", SECRET)
    .update(`chunk-cache-v1|${publicId}|${stablePrefix}|${exp}`)
    .digest("hex");
}

// Result of opaque-ID verification. `reason` distinguishes the specific failure
// for structured logging (OPAQUE_ID_EXPIRED, OPAQUE_ID_MALFORMED, OPAQUE_ID_TAMPERED).
// The verify path used to return null for every failure mode, making it
// impossible to tell "natural TTL rollover" apart from "tampered/forged URL".
export type OpaqueVerifyFailure = "OPAQUE_ID_MALFORMED" | "OPAQUE_ID_TAMPERED" | "OPAQUE_ID_EXPIRED";

// Strip the optional 16-hex chunk cache-key prefix. The encrypted opaque
// payload that follows is what we actually decrypt. Non-chunk types and
// legacy chunks without a prefix decrypt fine because the cipher length
// for a non-prefixed ID has IV(12) + CT(>=1) + TAG(16) ≥ 29 bytes = 58
// hex chars, while the prefix is exactly 16 hex chars added at the
// front. We can tell whether a prefix is present by trying decryption
// at both offsets; the wrong offset always fails GCM authentication.
function stripChunkCachePrefixIfPresent(id: string): { stripped: string; hadPrefix: boolean } {
  if (id.length > CHUNK_CACHE_PREFIX_LEN + 60 && /^[0-9a-f]+$/i.test(id)) {
    return { stripped: id.slice(CHUNK_CACHE_PREFIX_LEN), hadPrefix: true };
  }
  return { stripped: id, hadPrefix: false };
}

export function verifyOpaqueIdDetailed(id: string, overlapGraceSec: number = 3): { payload?: OpaquePayload; failure?: OpaqueVerifyFailure } {
  if (typeof id !== "string" || id.length < 60 || !/^[0-9a-f]+$/i.test(id)) {
    return { failure: "OPAQUE_ID_MALFORMED" };
  }
  // Try decryption with possible chunk-cache prefix stripped first, then
  // fall back to the raw ID. GCM authentication makes false-positives
  // (decrypting the wrong byte range successfully) cryptographically
  // negligible, so trying both is safe.
  const { stripped, hadPrefix } = stripChunkCachePrefixIfPresent(id);
  const tryDecrypt = (hex: string): OpaquePayload | null => {
    try {
      const buf = Buffer.from(hex, "hex");
      if (buf.length < 12 + 16 + 1) return null;
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(buf.length - 16);
      const ct = buf.subarray(12, buf.length - 16);
      const decipher = crypto.createDecipheriv("aes-256-gcm", stealthAesKey, iv);
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return JSON.parse(pt.toString("utf8")) as OpaquePayload;
    } catch {
      return null;
    }
  };
  let parsed: OpaquePayload | null = hadPrefix ? tryDecrypt(stripped) : null;
  if (!parsed) parsed = tryDecrypt(id);
  if (!parsed) {
    return { failure: "OPAQUE_ID_TAMPERED" };
  }
  if (typeof parsed.s !== "string" || typeof parsed.e !== "number") {
    return { failure: "OPAQUE_ID_TAMPERED" };
  }
  if (parsed.t !== "l" && parsed.t !== "c" && parsed.t !== "k" && parsed.t !== "m") {
    return { failure: "OPAQUE_ID_TAMPERED" };
  }
  const now = Math.floor(Date.now() / 1000);
  // Admin-configurable overlap grace (default 3s). With windowOverlapGraceSec=30
  // an expired bucket-rounded opaque ID still passes for 30s, so in-flight
  // segment/chunk/key fetches that hls.js scheduled BEFORE the playlist
  // refetched the new opaque IDs still succeed — no black screen at the
  // bucket boundary (~10 min into long sessions).
  const grace = Math.max(3, Math.floor(overlapGraceSec || 3));
  if (parsed.e + grace < now) return { failure: "OPAQUE_ID_EXPIRED" };
  return { payload: parsed };
}

export function verifyOpaqueId(id: string): OpaquePayload | null {
  return verifyOpaqueIdDetailed(id).payload || null;
}

// Decode an opaque ID and return its payload + exp without rejecting on
// expiry. Used by stealth media routes that need to look up the session's
// per-session `windowOverlapGraceSec` BEFORE deciding whether the exp is
// still acceptable. Returns null if the ID is malformed or tampered.
export function decodeOpaqueIdSkipExpiry(id: string): OpaquePayload | null {
  if (typeof id !== "string" || id.length < 60 || !/^[0-9a-f]+$/i.test(id)) return null;
  const tryOne = (hex: string): OpaquePayload | null => {
    try {
      const buf = Buffer.from(hex, "hex");
      if (buf.length < 12 + 16 + 1) return null;
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(buf.length - 16);
      const ct = buf.subarray(12, buf.length - 16);
      const decipher = crypto.createDecipheriv("aes-256-gcm", stealthAesKey, iv);
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      const parsed = JSON.parse(pt.toString("utf8")) as OpaquePayload;
      if (!parsed || typeof parsed.s !== "string" || typeof parsed.e !== "number") return null;
      if (parsed.t !== "l" && parsed.t !== "c" && parsed.t !== "k" && parsed.t !== "m") return null;
      return parsed;
    } catch {
      return null;
    }
  };
  const { stripped, hadPrefix } = stripChunkCachePrefixIfPresent(id);
  return (hadPrefix && tryOne(stripped)) || tryOne(id);
}

export function isOpaqueExpired(payload: OpaquePayload, graceSec: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  const grace = Math.max(3, Math.floor(graceSec || 3));
  return payload.e + grace < now;
}

// Snap an absolute expiry to a bucket boundary so successive mints within the
// same wall-clock bucket produce the SAME `exp` field — and therefore the same
// deterministic IV → same opaque URL. Without this, exp would increment every
// second and every playlist refetch would still produce a fresh URL.
//
// We round UP to the next bucket boundary, so the resulting exp is always
// >= (now + ttlSec). Practical effect: tokens live for `[ttlSec, ttlSec + BUCKET)`
// instead of exactly ttlSec. BUCKET=60s means at worst 1 extra minute, which is
// negligible compared to the 300s/3600s TTLs in use.
export function bucketExp(ttlSec: number, bucketSec: number = 60): number {
  const target = Math.floor(Date.now() / 1000) + Math.max(1, ttlSec);
  return Math.ceil(target / bucketSec) * bucketSec;
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
  // Wall-clock timestamp when the session was revoked. Used by media routes
  // (chunk/secret/window) to allow in-flight requests with the old SID to
  // succeed for `windowOverlapGraceSec` seconds after a *rotation* (signal
  // === "rotated"). Hard revokes (abuse, manual) are NOT graced.
  revokedAt: number | null;
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
  // Wall-clock ms of the most recent `seekTo:true` progress update. Used by
  // `validateSegmentWindow` to widen the allowed segment window briefly so
  // chunks belonging to a just-completed seek aren't rejected by the
  // pre-seek currentSegmentIndex (race between in-flight chunk requests and
  // the seekTo POST). 0 means no seek has occurred this session.
  lastSeekAt: number;
  // ── EVENT-style sliding window (monotonic growth) ─────────────────────
  // Highest segment index ever exposed in any playlist response for this
  // session. The variant playlist windowEnd is `max(maxSegmentExposed,
  // currentSegmentIndex + windowSegs)` so the playlist NEVER shrinks. This
  // is required for `#EXT-X-PLAYLIST-TYPE:EVENT` compliance — EVENT
  // playlists may only append segments, never remove them. Without this,
  // backward seeks would cause windowEnd to drop, hls.js would observe a
  // shrunken playlist and reject it as stale, leaving the player frozen
  // with a permanent buffering spinner.
  maxSegmentExposed: number;
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
  // AES master key path (fixed per video, stored at session creation so the
  // /stream/secret endpoint can skip the DB lookup entirely — ~250ms savings
  // per key fetch).
  encryptionKeyPath: string | null;
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

// ────────────────────────────────────────────────────────────────────────────
// Cross-instance session persistence (Postgres-backed)
// ────────────────────────────────────────────────────────────────────────────
// Why this exists:
//   Railway / Vercel auto-scale to multiple instances under load. The in-memory
//   `sessions` Map above is per-instance, so a session created on Instance A
//   isn't visible to Instance B. The load balancer is not sticky for HLS
//   segment fetches, so the same player's requests fan out across instances.
//   That caused intermittent "Session invalid or expired" 403s in production.
//
// Design:
//   • Postgres `video_sessions` table is the durable source of truth.
//   • Each instance keeps the in-memory Map as a hot L1 cache.
//   • On createSession / rotateSession / revokeSession / extendSession /
//     setIntegrationSessionId we write through to Postgres.
//   • On any cross-instance request, getSessionAsync() lazily loads the row
//     into the local Map. After that one read, all subsequent sync code paths
//     work unchanged (sessions.get(sid) returns the hydrated session).
//   • Counter-only mutations (abuseScore, requestLog, segment progress) stay
//     in the local Map for performance — abuse detection works per-instance,
//     and revocation propagates globally via the durable layer.
//   • A periodic sweeper deletes expired rows.
//
// What we serialize:
//   All scalar/array fields directly. `variantCache` (Map) is omitted (rebuilt
//   on demand from the upstream playlist). Buffers are base64-encoded.
// ────────────────────────────────────────────────────────────────────────────

function serializeSession(s: VideoSession): Record<string, any> {
  const { variantCache: _vc, ephemeralKey, ephemeralIV, ...rest } = s;
  return {
    ...rest,
    ephemeralKey: ephemeralKey.toString("base64"),
    ephemeralIV: ephemeralIV.toString("base64"),
  };
}

function deserializeSession(raw: any): VideoSession {
  return {
    ...raw,
    variantCache: new Map(),
    ephemeralKey: Buffer.from(raw.ephemeralKey, "base64"),
    ephemeralIV: Buffer.from(raw.ephemeralIV, "base64"),
    // Defensive defaults — these arrays/scalars must exist for sync code paths.
    requestLog: raw.requestLog || [],
    playlistFetchLog: raw.playlistFetchLog || [],
    keyHitLog: raw.keyHitLog || [],
    segmentFetchLog: raw.segmentFetchLog || [],
    velocityLog: raw.velocityLog || [],
    lastHeartbeatNonces: raw.lastHeartbeatNonces || [],
    concurrentSegments: raw.concurrentSegments ?? 0,
    abuseScore: raw.abuseScore ?? 0,
    breachEvents: raw.breachEvents ?? 0,
    outOfWindowCount: raw.outOfWindowCount ?? 0,
    lastSeekAt: raw.lastSeekAt ?? 0,
    maxSegmentExposed: raw.maxSegmentExposed ?? 0,
    keyIssuedCount: raw.keyIssuedCount ?? 0,
    clientSecurityEvents: raw.clientSecurityEvents ?? 0,
    encryptionKeyPath: raw.encryptionKeyPath ?? null,
  } as VideoSession;
}

// Per-sid serialized write queue. Without this, two fire-and-forget upserts
// for the same sid can race and the older one can clobber the newer state
// (e.g. createSession() then setIntegrationSessionId() — if create lands last
// it would wipe integrationSessionId back to null).
const writeQueues = new Map<string, Promise<void>>();

async function doPersist(sid: string): Promise<void> {
  if (videoSessionsTableMissing) return;
  // Re-read live state at the moment this write actually runs, so the queued
  // write always reflects the current in-memory truth (not a snapshot from
  // when persistSession was called).
  const s = sessions.get(sid);
  if (!s) return;
  const data = serializeSession(s);
  await db
    .insert(videoSessions)
    .values({
      sid,
      publicId: s.publicId,
      data: data as any,
      revoked: s.revoked,
      expiresAt: new Date(s.expiresAt),
      integrationSessionId: s.integrationSessionId ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: videoSessions.sid,
      set: {
        data: data as any,
        revoked: s.revoked,
        expiresAt: new Date(s.expiresAt),
        integrationSessionId: s.integrationSessionId ?? null,
        updatedAt: new Date(),
      },
    });
}

// Fire-and-forget write-through, serialized per sid. Errors are logged but
// never thrown — playback must not fail because Postgres hiccuped.
function persistSession(sid: string): void {
  const prev = writeQueues.get(sid) || Promise.resolve();
  const next = prev
    .catch(() => {}) // don't propagate prior failures to the new write
    .then(() => doPersist(sid))
    .catch((err: any) => {
      noteDbErr(err);
      if (!videoSessionsTableMissing) console.error(`[video-session] persist failed sid=${sid}:`, err?.message || err);
    });
  writeQueues.set(sid, next);
  next.finally(() => {
    if (writeQueues.get(sid) === next) writeQueues.delete(sid);
  });
}

async function loadSessionFromDb(sid: string): Promise<VideoSession | undefined> {
  if (videoSessionsTableMissing) return undefined;
  try {
    const rows = await db
      .select()
      .from(videoSessions)
      .where(eq(videoSessions.sid, sid))
      .limit(1);
    if (!rows.length) return undefined;
    const row = rows[0];
    // Hard expiry / revocation gate at load time so an instance never serves
    // a stale row that another instance already invalidated.
    if (row.revoked) return undefined;
    if (row.expiresAt.getTime() < Date.now()) return undefined;
    const s = deserializeSession(row.data);
    // CRITICAL: prefer authoritative column values over JSON blob fields.
    // `extendSession` writes only the expires_at column (cheap fast path), so
    // the JSON `expiresAt` can lag behind by many minutes. Same for `revoked`.
    s.expiresAt = row.expiresAt.getTime();
    s.revoked = row.revoked;
    s.integrationSessionId = row.integrationSessionId ?? s.integrationSessionId ?? undefined;
    lastDbRevalidateAt.set(sid, Date.now());
    sessions.set(sid, s);
    return s;
  } catch (err: any) {
    noteDbErr(err);
    if (!videoSessionsTableMissing) console.error(`[video-session] load failed sid=${sid}:`, err?.message || err);
    return undefined;
  }
}

// Tracks the last time we re-checked Postgres for revocation/expiry on a
// cache-hit. Without this, an instance that already cached a session would
// never see a revoke/rotate done on a different instance and could serve
// playback until its own expiry. Revalidation TTL of 5s caps the staleness
// window without crushing the DB (1 lightweight SELECT per session per 5s).
const lastDbRevalidateAt = new Map<string, number>();
const REVALIDATE_INTERVAL_MS = 5_000;

// Circuit breaker: if the `video_sessions` table is missing (un-migrated DB),
// every query throws and adds 1-4 s of latency per request (each chunk fetch,
// heartbeat, playlist refresh). Once we see "relation ... does not exist" we
// flip this flag and skip all DB ops for the rest of the process lifetime.
// In-memory session map continues to work fine on a single instance.
// Cross-instance revoke/rotate propagation is the only thing lost; that comes
// back automatically as soon as the operator runs `npm run db:push`.
let videoSessionsTableMissing = false;
function isMissingTableError(err: any): boolean {
  // Postgres SQLSTATE 42P01 = undefined_table. Driver surfaces it as .code
  // (node-postgres) or err.cause?.code (drizzle wraps). Faster + more robust
  // than message matching.
  const code = err?.code || err?.cause?.code || err?.original?.code;
  if (code === "42P01") return true;
  const msg = String(err?.message || err || "");
  return msg.includes('relation "video_sessions" does not exist')
      || msg.includes('relation \\"video_sessions\\" does not exist')
      || msg.includes("video_sessions") && msg.includes("does not exist");
}
function noteDbErr(err: any): void {
  if (!videoSessionsTableMissing && isMissingTableError(err)) {
    videoSessionsTableMissing = true;
    console.error("[video-session] video_sessions table missing — DB write-through DISABLED for this process. Run `npm run db:push` on the server to enable cross-instance session sync.");
  }
}

async function revalidateFromDb(sid: string, local: VideoSession): Promise<void> {
  if (videoSessionsTableMissing) { lastDbRevalidateAt.set(sid, Date.now()); return; }
  try {
    const rows = await db
      .select({
        revoked: videoSessions.revoked,
        expiresAt: videoSessions.expiresAt,
        integrationSessionId: videoSessions.integrationSessionId,
      })
      .from(videoSessions)
      .where(eq(videoSessions.sid, sid))
      .limit(1);
    lastDbRevalidateAt.set(sid, Date.now());
    if (!rows.length) return; // row deleted by cleanup — leave local copy alone
    const row = rows[0];
    if (row.revoked && !local.revoked) {
      local.revoked = true;
      local.revokeReason = local.revokeReason || { signal: "rate_limit", detail: "Revoked on another instance" };
    }
    // Trust DB expiry only if it's newer than what we have locally — never
    // shorten a session that this instance just extended.
    const dbExp = row.expiresAt.getTime();
    if (dbExp > local.expiresAt) local.expiresAt = dbExp;
    if (row.integrationSessionId && !local.integrationSessionId) {
      local.integrationSessionId = row.integrationSessionId;
    }
  } catch (err: any) {
    // Soft-fail: if DB is unreachable, keep serving from local cache.
    noteDbErr(err);
    lastDbRevalidateAt.set(sid, Date.now()); // prevent tight retry loop
    if (!videoSessionsTableMissing) console.error(`[video-session] revalidate failed sid=${sid}:`, err?.message || err);
  }
}

/**
 * Async-aware session lookup. Use this at the start of any request handler
 * that needs the session — it hydrates the local Map from Postgres on a cache
 * miss, and periodically revalidates revoke/expiry state on a cache hit.
 * After this returns, the rest of the handler can use the synchronous
 * `getSession(sid)` / `sessions.get(sid)` paths unchanged.
 *
 * Returns undefined if the session doesn't exist (anywhere), is revoked, or
 * is past its expiry.
 */
export async function getSessionAsync(sid: string): Promise<VideoSession | undefined> {
  const local = sessions.get(sid);
  if (local) {
    const last = lastDbRevalidateAt.get(sid) || 0;
    if (Date.now() - last >= REVALIDATE_INTERVAL_MS) {
      await revalidateFromDb(sid, local);
    }
    if (Date.now() > local.expiresAt) {
      local.revoked = true;
      local.revokeReason = local.revokeReason || { signal: "rate_limit", detail: "Session expired" };
    }
    return local;
  }
  return await loadSessionFromDb(sid);
}

// Periodic cleanup of expired rows. Runs every 5 min on every instance — the
// DELETE is idempotent so concurrent sweeps are safe. unref() so it doesn't
// keep Node alive on shutdown.
setInterval(() => {
  if (videoSessionsTableMissing) return;
  db.delete(videoSessions)
    .where(lt(videoSessions.expiresAt, new Date()))
    .catch((err) => { noteDbErr(err); if (!videoSessionsTableMissing) console.error("[video-session] cleanup failed:", err?.message || err); });
}, 5 * 60 * 1000).unref();

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
  encryptionKeyPath: string | null = null,
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
    revokedAt: null,
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
    lastSeekAt: 0,
    maxSegmentExposed: 0,
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
    encryptionKeyPath,
    clientSecurityEvents: 0,
    integrationSessionId: undefined,
  });
  persistSession(sid);
  return sid;
}

export function setIntegrationSessionId(sid: string, integrationSessionId: string): boolean {
  const s = sessions.get(sid);
  if (!s) return false;
  s.integrationSessionId = integrationSessionId;
  persistSession(sid);
  return true;
}

export function revokeSessionsByIntegrationId(integrationSessionId: string, reason?: AbuseReason): number {
  let count = 0;
  for (const [sid, s] of sessions) {
    if (s.integrationSessionId === integrationSessionId && !s.revoked) {
      s.revoked = true;
      if (reason) s.revokeReason = reason;
      persistSession(sid);
      count++;
    }
  }
  // Also revoke on other instances by writing through to Postgres directly for
  // any rows that aren't currently hydrated locally.
  if (!videoSessionsTableMissing) {
    db.update(videoSessions)
      .set({ revoked: true, updatedAt: new Date() })
      .where(
        and(
          eq(videoSessions.integrationSessionId, integrationSessionId),
          eq(videoSessions.revoked, false),
        ),
      )
      .catch((err) => { noteDbErr(err); if (!videoSessionsTableMissing) console.error("[video-session] revokeByIntegrationId write-through failed:", err?.message || err); });
  }
  return count;
}

export function rotateSession(oldSid: string, resumePositionSec?: number): string | null {
  const old = sessions.get(oldSid);
  if (!old || old.revoked) return null;

  // If the client sends the actual playback position, seed the new session's
  // currentSegmentIndex from there. Without this, the new session inherits
  // the server-lagged index (last tick value), and the variant-playlist window
  // won't cover the resume point — causing hls.startLoad(resumeAt) to fail
  // silently and fall back to segment 0.
  const resumeSegIdx = (resumePositionSec !== undefined && isFinite(resumePositionSec) && resumePositionSec > 0)
    ? Math.floor(resumePositionSec / 2)
    : old.currentSegmentIndex;

  const newSid = crypto.randomBytes(16).toString("hex");
  const keyExp = Math.floor(Date.now() / 1000) + Math.floor(SESSION_MAX_AGE_MS / 1000);
  const keySig = signPath(newSid, "/key", keyExp);

  sessions.set(newSid, {
    ...old,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_MAX_AGE_MS,
    revoked: false,
    revokeReason: null,
    revokedAt: null,
    abuseScore: 0,
    breachEvents: 0,
    blockedUntil: null,
    requestLog: [],
    playlistFetchLog: [],
    keyHitLog: [],
    segmentFetchLog: [],
    concurrentSegments: 0,
    outOfWindowCount: 0,
    lastSeekAt: 0,
    // Seed from the actual player position, not the lagged server state,
    // so the first variant-playlist response already covers the resume point.
    currentSegmentIndex: resumeSegIdx,
    maxSegmentExposed: Math.max(old.maxSegmentExposed, resumeSegIdx),
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
  // signal="rotated" — distinguishes a benign rotation from a real abuse
  // revocation. Media routes (chunk/secret/window) check for this signal
  // and allow in-flight requests with the old SID to succeed for the
  // overlap-grace window, so HLS.js never sees a 403 during the transition.
  old.revokeReason = { signal: "rotated" as any, detail: "Session rotated" };
  old.revokedAt = Date.now();

  // Persist both: new session for cross-instance hydration, old as revoked so
  // any other instance that still has it cached will reject on next access.
  persistSession(newSid);
  persistSession(oldSid);

  console.log(`[video-session] SESSION_ROTATED: oldSid=${oldSid} → newSid=${newSid}, publicId=${old.publicId}`);
  return newSid;
}

/**
 * Media-route session lookup that tolerates a *rotation* during the overlap
 * grace window. Used ONLY by stealth chunk/secret/window handlers so in-flight
 * segment fetches scheduled against the old SID succeed for `graceSec` seconds
 * after rotateSession() flips the old SID to revoked. Returns null if the
 * session was hard-revoked (abuse, manual, expired) or if the grace expired.
 *
 * IMPORTANT: This does NOT bypass abuse-detection revocations or expiry —
 * only rotation-revocations within the grace window.
 */
export function getSessionAllowingRotationGrace(sid: string, graceSec: number): VideoSession | undefined {
  const s = sessions.get(sid);
  if (!s) return undefined;
  if (Date.now() > s.expiresAt) {
    s.revoked = true;
    s.revokeReason = { signal: "rate_limit", detail: "Session expired" };
    return undefined;
  }
  if (s.revoked) {
    const isRotation = (s.revokeReason as any)?.signal === "rotated";
    const within = s.revokedAt != null && (Date.now() - s.revokedAt) < Math.max(0, graceSec) * 1000;
    if (isRotation && within) return s;
    return undefined;
  }
  return s;
}

/**
 * Cross-instance-safe rotation-grace lookup. The synchronous variant above
 * only checks the in-memory `sessions` map, which on a fresh instance (after
 * a Vercel function cold start, or when the rotation happened on a sibling
 * instance behind a non-sticky LB) will be empty for the OLD SID. The old
 * SID's row is persisted with `revoked=true`, so `loadSessionFromDb()`
 * refuses to hydrate it. This function bypasses that filter when (and only
 * when) the row's revoke-reason signal is "rotated" AND the row's
 * `revokedAt` (read from the serialized blob) is within the grace window.
 *
 * Also returns a precise status (`kind`) so the caller can distinguish
 * recoverable expiry/not-found from a genuine abuse/manual revocation
 * for accurate response codes.
 */
export type RotationGraceStatus =
  | { kind: "active"; session: VideoSession }
  | { kind: "rotation_grace"; session: VideoSession }
  | { kind: "not_found" }
  | { kind: "expired"; expiresAt: number }
  | { kind: "revoked"; signal: string };

export async function getSessionAllowingRotationGraceAsync(
  sid: string,
  graceSec: number,
): Promise<RotationGraceStatus> {
  // Cheap fast path — already in memory (active OR rotation-revoked recently).
  let s = sessions.get(sid);
  if (s) {
    // Periodic revalidation so revokes done on another instance are seen.
    const last = lastDbRevalidateAt.get(sid) || 0;
    if (Date.now() - last >= REVALIDATE_INTERVAL_MS) {
      await revalidateFromDb(sid, s);
    }
  } else {
    if (videoSessionsTableMissing) return { kind: "not_found" };
    // Not cached — hydrate from DB. loadSessionFromDb skips revoked rows,
    // so do a raw read here that does NOT filter on revoked, then decide.
    try {
      const rows = await db
        .select()
        .from(videoSessions)
        .where(eq(videoSessions.sid, sid))
        .limit(1);
      if (!rows.length) return { kind: "not_found" };
      const row = rows[0];
      const expMs = row.expiresAt.getTime();
      if (expMs < Date.now()) return { kind: "expired", expiresAt: expMs };
      const hydrated = deserializeSession(row.data);
      hydrated.expiresAt = expMs;
      hydrated.revoked = row.revoked;
      hydrated.integrationSessionId = row.integrationSessionId ?? hydrated.integrationSessionId ?? undefined;
      if (!row.revoked) {
        // Healthy — cache it normally and return active.
        sessions.set(sid, hydrated);
        lastDbRevalidateAt.set(sid, Date.now());
        s = hydrated;
      } else {
        // Revoked row — only allow if rotation grace + within window.
        const reason = (hydrated.revokeReason as any) || {};
        const isRotation = reason.signal === "rotated";
        const revokedAt = hydrated.revokedAt;
        const within = isRotation && revokedAt != null
          && (Date.now() - revokedAt) < Math.max(0, graceSec) * 1000;
        if (within) {
          // Cache so subsequent in-flight requests for the SAME old SID can
          // reuse without another DB round-trip during the brief grace
          // window. The row will become unreachable as soon as grace
          // expires; periodic cleanup will purge eventually.
          sessions.set(sid, hydrated);
          lastDbRevalidateAt.set(sid, Date.now());
          return { kind: "rotation_grace", session: hydrated };
        }
        return { kind: "revoked", signal: reason.signal || "rate_limit" };
      }
    } catch (err: any) {
      noteDbErr(err);
      if (!videoSessionsTableMissing) console.error(`[video-session] grace-lookup failed sid=${sid}:`, err?.message || err);
      return { kind: "not_found" };
    }
  }
  // Reach here with s defined from cache or fresh hydrate.
  if (Date.now() > s.expiresAt) {
    s.revoked = true;
    s.revokeReason = s.revokeReason || { signal: "rate_limit", detail: "Session expired" };
    return { kind: "expired", expiresAt: s.expiresAt };
  }
  if (s.revoked) {
    const reason = (s.revokeReason as any) || {};
    const isRotation = reason.signal === "rotated";
    const within = s.revokedAt != null && (Date.now() - s.revokedAt) < Math.max(0, graceSec) * 1000;
    if (isRotation && within) return { kind: "rotation_grace", session: s };
    return { kind: "revoked", signal: reason.signal || "rate_limit" };
  }
  return { kind: "active", session: s };
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
  // Cheap write — just updates expires_at so other instances see the new TTL
  // when they hydrate. Failure here doesn't break playback on this instance.
  if (!videoSessionsTableMissing) {
    db.update(videoSessions)
      .set({ expiresAt: new Date(s.expiresAt), updatedAt: new Date() })
      .where(eq(videoSessions.sid, sid))
      .catch((err) => { noteDbErr(err); if (!videoSessionsTableMissing) console.error(`[video-session] extend write-through failed sid=${sid}:`, err?.message || err); });
  }
  vlog(`[video-session] SESSION_EXTENDED: sid=${sid}, publicId=${s.publicId}, newExpiry=${new Date(s.expiresAt).toISOString()}`);
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
    persistSession(sid);
    // Propagate to integration session row (LMS API flow)
    if (s.integrationSessionId && integrationRevokeNotifier) {
      try {
        integrationRevokeNotifier(s.integrationSessionId, reason?.detail || reason?.signal || "abuse_revoked");
      } catch (e) {
        console.error("[video-session] integration revoke notifier failed:", e);
      }
    }
  } else {
    // Session not in this instance's L1 cache — still revoke in Postgres so
    // any other instance that holds it will see revoked=true on next hydrate.
    if (!videoSessionsTableMissing) {
      db.update(videoSessions)
        .set({ revoked: true, updatedAt: new Date() })
        .where(eq(videoSessions.sid, sid))
        .catch((err) => { noteDbErr(err); if (!videoSessionsTableMissing) console.error(`[video-session] revoke write-through failed sid=${sid}:`, err?.message || err); });
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

  // IP tracking removed from the hot path: HLS playlist requests arrive
  // through the Cloudflare Worker (worker IP) while segments arrive directly
  // from the browser (browser IP), so IP binding cannot be enforced without
  // false positives. SID + HMAC signature + UA hash + device hash already
  // authenticate the session — recording an IP we'd never use was pure write
  // overhead on every segment.
  return { abused: false };
}

export function trackPlaylistFetch(sid: string, ip?: string): { abused: boolean; reason?: AbuseReason } {
  const base = trackRequest(sid, ip);
  if (base.abused) return base;

  const s = sessions.get(sid)!;

  // When suspicious detection is disabled, skip rate-based checks
  if (!s.suspiciousDetectionEnabled) return { abused: false };

  const now = Date.now();

  // Grace window: skip playlist rate-counting for the first 30 seconds after
  // session creation. Initial buffering, quality probing, and the first sliding
  // playlist refresh can all happen within the first 10s — too tight a grace
  // window false-trips on normal startup.
  if (now - s.createdAt < 30_000) return { abused: false };

  // Keep playlist fetches in a 5-second window
  s.playlistFetchLog = s.playlistFetchLog.filter(t => t > now - 5000);
  s.playlistFetchLog.push(now);

  // Threshold raised from 5 → 25 in 5s. The sliding-window HLS playlist is
  // legitimately refetched by hls.js every targetDuration (~2s = 2-3/5s),
  // multiplied by quality-level switches, seeks, and transient retries.
  // The OLD limit of 5/5s was triggering on normal playback within seconds.
  // Real scrapers hit hundreds in 5s — 25 still catches them while leaving
  // 8-10x headroom for legitimate hls.js behavior.
  if (s.playlistFetchLog.length > 25) {
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
  const now = Date.now();

  // ── Self-healing concurrent-segment ring ────────────────────────────────
  // Replaces the old simple integer counter that could leak on any error
  // path that forgot to call releaseSegment(). Now we push the acquisition
  // timestamp into a ring buffer, evict anything older than the configured
  // TTL on every read, and treat the post-eviction length as the live count.
  // releaseSegment() pops the oldest entry (FIFO). This means:
  //   • A stuck acquisition auto-releases after concurrentSegmentTtlMs
  //   • No need for a global sweep timer
  //   • False 429s caused by counter drift are now impossible
  const ring: number[] = (s as any)._segAcqRing || ((s as any)._segAcqRing = []);
  // Evict expired acquisitions
  const cutoff = now - ABUSE_THRESHOLDS.concurrentSegmentTtlMs;
  while (ring.length > 0 && ring[0] < cutoff) ring.shift();
  ring.push(now);
  // Mirror to the legacy counter for any external readers/diagnostics.
  s.concurrentSegments = ring.length;

  // When suspicious detection is disabled, allow all concurrent downloads
  if (!s.suspiciousDetectionEnabled) return { abused: false };

  // Abuse-gated cap: the strict 8-cap only applies when abuseScore is already
  // elevated (>= 50% of violationLimit). Otherwise the generous 64-cap holds.
  // Normal hls.js bursts almost never reach 64; a scraper that's tripped any
  // other signal (velocity/playlist/key) gets clamped to 8 on the next wave.
  const effectiveCap =
    s.abuseScore >= Math.ceil(s.violationLimit / 2)
      ? ABUSE_THRESHOLDS.concurrentSegmentsElevated
      : ABUSE_THRESHOLDS.concurrentSegments;

  if (ring.length > effectiveCap) {
    // Pop the entry we just added so this request doesn't count
    ring.pop();
    s.concurrentSegments = ring.length;
    // Only score abuse if we're already in the elevated regime — otherwise
    // this is a soft notice. Velocity scoring remains the primary defense.
    if (effectiveCap === ABUSE_THRESHOLDS.concurrentSegmentsElevated) {
      const reason: AbuseReason = {
        signal: "concurrent",
        detail: `${ring.length + 1} concurrent segment requests under elevated abuse (cap: ${effectiveCap})`,
      };
      vlog(`[video-session] SECURITY_BLOCK_REASON: CONCURRENT_SEGMENTS_ELEVATED | sid=${sid} concurrent=${ring.length + 1} score=${s.abuseScore} publicId=${s.publicId}`);
      return addAbuse(s, 5, reason);
    }
    // Low-score regime: do not deny, do not score. Just log and continue.
    // hls.js retries naturally on the next tick; user sees no error.
    vlog(`[video-session] SEGMENT_CONCURRENT_HIGH (soft, no deny) | sid=${sid} concurrent=${ring.length + 1} cap=${effectiveCap} score=${s.abuseScore}`);
  }

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
  if (!s) return;
  const ring: number[] | undefined = (s as any)._segAcqRing;
  if (ring && ring.length > 0) {
    // FIFO pop — the oldest acquisition pairs with this release.
    ring.shift();
    s.concurrentSegments = ring.length;
  } else if (s.concurrentSegments > 0) {
    // Defensive fallback for any pre-ring sessions still alive in memory.
    s.concurrentSegments -= 1;
  }
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

// Update the session's playback position.
//
// `seekTo=false` (periodic/heartbeat progress reports): monotonic-forward only.
//   Any post carrying a segmentIndex *behind* the current one is ignored. This
//   defends against the post-rotation race where `hls.loadSource(newUrl)`
//   briefly flushes MSE → `video.currentTime` momentarily reads 0 → a
//   periodic progress interval fires with the NEW sid and would otherwise
//   reset the freshly-rotated session's window from [start,end] back to
//   [0, windowSegs]. The subsequent in-flight chunk for the real position
//   then trips `out_of_window` and freezes hls.js.
//
// `seekTo=true` (explicit seek by the user, or a rotation-completion post
// re-anchoring to a known-good position): allowed to move backward. Callers
// must only set this flag for intentional re-positioning.
export function updateProgress(sid: string, segmentIndex: number, seekTo: boolean = false): boolean {
  const s = sessions.get(sid);
  if (!s || s.revoked) return false;
  let clamped = Math.max(0, segmentIndex);
  if (seekTo) {
    // ── FORWARD-SEEK EXPOSURE CAP ───────────────────────────────────────
    // EVENT-style playlists expose all segments in [0, max(maxSegmentExposed,
    // currentSegmentIndex + windowSegs)]. A forged `seekTo:true` with a
    // very large `currentTime` would otherwise let a holder of the SID
    // immediately set currentSegmentIndex to the last segment, causing the
    // next playlist response to expose the ENTIRE video in a single
    // request. To bound that risk, we cap how far a single seek can
    // advance the high-water mark beyond what has already been earned.
    //
    // SEEK_FORWARD_CAP_SEGS = 900 = 30 min of 2s segments — comfortably
    // larger than any legitimate scrub jump a user makes manually, but
    // small enough that scraping the whole video via repeated forged
    // seeks still has to clear `bulk_download` / `velocity_abuse` /
    // rate-limit abuse detection. Backward seeks are NOT capped.
    const windowSegs = getWindowSegs(s);
    const earnedCeiling = Math.max(s.currentSegmentIndex, s.maxSegmentExposed) + windowSegs;
    const SEEK_FORWARD_CAP_SEGS = 900;
    const seekCeiling = earnedCeiling + SEEK_FORWARD_CAP_SEGS;
    if (clamped > seekCeiling) {
      clamped = seekCeiling;
    }
    s.currentSegmentIndex = clamped;
    // Mark the seek timestamp so validateSegmentWindow can grant a brief
    // grace period covering the race between the seekTo POST landing and
    // hls.js issuing chunk requests for the new position. Also clear the
    // out-of-window counter + sustained-pattern log: chunks queued for the
    // OLD position before stopLoad cancellation must not poison the new
    // session's abuse score.
    s.lastSeekAt = Date.now();
    s.outOfWindowCount = 0;
    (s as any)._oowLog = [];
  } else {
    // Forward-only — never regress the window from a stale or racy report.
    //
    // STALE-ADVANCE GUARD ─────────────────────────────────────────────────
    // Problem: when the user seeks backward (e.g. t=13:37 → t=0:08), an
    // in-flight progress POST from the OLD position (idx=412) may arrive at
    // the server AFTER the seekTo POST (idx=4) has already moved the window
    // to [3, 27]. Because this path is forward-only, 412 > 4 → window jumps
    // to [411, 435] → hls.js requesting seg_004 gets 403 → freeze.
    //
    // Fix: within SEEK_STALE_GUARD_MS after a seekTo, ignore any non-seekTo
    // advance that jumps more than SEEK_STALE_MAX_JUMP_SEGS ahead of the
    // current index. Threshold is generous (20 segs = 40 s) so legitimate
    // fast-forward / rebuffer advances are never blocked. A stale post from
    // t=13:37 arriving after a seek to t=0:08 has jump=408 >> 20 → dropped.
    const SEEK_STALE_GUARD_MS = 5000;
    const SEEK_STALE_MAX_JUMP_SEGS = 20;
    if (
      s.lastSeekAt > 0 &&
      Date.now() - s.lastSeekAt < SEEK_STALE_GUARD_MS &&
      clamped > s.currentSegmentIndex + SEEK_STALE_MAX_JUMP_SEGS
    ) {
      // Drop silently — stale pre-seek progress post arriving late.
      // Return true so the HTTP layer returns 200 (no client-visible error).
      return true;
    }
    s.currentSegmentIndex = Math.max(s.currentSegmentIndex, clamped);
  }
  s.lastProgressAt = Date.now();
  return true;
}

// Assume ~2s per HLS segment (matches ffmpeg HLS output throughout this codebase).
const SEG_DURATION_SEC = 2;

// Single source of truth for the segment-window budget. Admin sets
// maxPrebufferSec via the Security Profile; we convert to segments here.
// A 2-segment safety minimum keeps hls.js from stalling if a misconfigured
// profile passes a near-zero value.
export function getWindowSegs(s: { hardening: SessionHardeningConfig }): number {
  return Math.max(2, Math.ceil((s.hardening.maxPrebufferSec || 0) / SEG_DURATION_SEC));
}

function oowGraceSegsFor(s: VideoSession): number {
  return Math.max(2, Math.ceil((s.hardening.windowOverlapGraceSec || 0) / SEG_DURATION_SEC));
}

/**
 * Bump the EVENT-playlist high-water mark and persist it across instances.
 *
 * Called by the playlist handlers after computing `windowEnd`. Persistence is
 * required so that in a multi-instance / non-sticky deployment, another node
 * hydrating the same session from Postgres doesn't emit a *shrunk* playlist
 * relative to what HLS.js already observed — which would re-trigger the EVENT
 * protocol violation this whole fix is designed to prevent.
 *
 * Persistence is throttled to growths of >= 4 segments (≈8s of content) so we
 * don't hammer the DB on every playlist refresh. The in-memory value is
 * always updated; only the DB write is batched.
 */
export function bumpMaxSegmentExposed(sid: string, newEnd: number): void {
  const s = sessions.get(sid);
  if (!s) return;
  if (newEnd <= s.maxSegmentExposed) return;
  const grew = newEnd - s.maxSegmentExposed;
  s.maxSegmentExposed = newEnd;
  if (grew >= 4) {
    persistSession(sid);
  }
}

export function getWindowRange(sid: string): { start: number; end: number } {
  const s = sessions.get(sid);
  if (!s) return { start: 0, end: ABUSE_THRESHOLDS.windowSize };
  // EVENT-style window: start is always 0 (backward seek allowed to any
  // previously-exposed segment). End is the monotonically growing
  // high-water mark so backward seeks don't shrink the playlist.
  const start = 0;
  const end = Math.max(s.maxSegmentExposed, s.currentSegmentIndex + getWindowSegs(s));
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
    // EVENT-style window: backward seek is always allowed (start=0). The
    // forward limit is the high-water mark of what has actually been
    // exposed in playlist responses, so scrapers can't request segments
    // that haven't been advertised yet. The high-water mark grows
    // monotonically with playback progress.
    const windowSegs = getWindowSegs(s);
    const start = 0;
    const end = Math.max(s.maxSegmentExposed, s.currentSegmentIndex + windowSegs);

    // ── SEEK GRACE ──────────────────────────────────────────────────────
    // After a user seek, hls.js issues a burst of chunk requests around the
    // new position. The seekTo POST has *already* moved currentSegmentIndex,
    // but a few in-flight requests for the OLD position may still arrive,
    // AND hls.js may overshoot the configured window by several segments
    // while it re-buffers. During the configured overlap-grace window after
    // a seek, accept any segment in [target - 2*windowSegs, target + 2*windowSegs]
    // and DO NOT increment the OOW counter so the legitimate seek burst
    // can't push the session into SECURITY_OUT_OF_WINDOW_SUSTAINED.
    if (s.lastSeekAt > 0) {
      const seekGraceMs = Math.max(3000, (s.hardening.windowOverlapGraceSec || 3) * 1000);
      if (Date.now() - s.lastSeekAt < seekGraceMs) {
        // During seek grace, allow any past segment (start=0) plus the
        // forward overshoot hls.js does while re-buffering at the new
        // position.
        const wideStart = 0;
        const wideEnd = Math.max(s.maxSegmentExposed, s.currentSegmentIndex + 2 * windowSegs);
        if (segIndex >= wideStart && segIndex <= wideEnd) {
          return { allowed: true };
        }
        // Even outside the wide window during seek grace, deny without
        // scoring — the player should recover via its 403-after-seek path.
        return { allowed: false, reason: { signal: "out_of_window", detail: `seg=${segIndex} outside seek-grace window [${wideStart},${wideEnd}]` } };
      }
    }

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
      // N is admin-configurable via windowOverlapGraceSec (converted to segs).
      if (s.outOfWindowCount <= oowGraceSegsFor(s)) {
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
  // Bulk-download budget driven by admin-configured maxDownloadAheadSec
  // (single source of truth; downloadAheadLimit is derived from it in
  // buildHardening so they can't disagree).
  const burstBudget = Math.max(5, Math.ceil((s.hardening.maxDownloadAheadSec || 0) / SEG_DURATION_SEC));
  if (s.velocityLog.length > burstBudget) {
    const reason: AbuseReason = {
      signal: "velocity_abuse",
      detail: `${s.velocityLog.length} segments in 5s exceeds burst=${burstBudget} | publicId=${s.publicId}`,
    };
    console.log(`[video-session] SECURITY_VELOCITY_ABUSE: sid=${sid} segs_5s=${s.velocityLog.length} burst=${burstBudget}`);
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
  playbackRate?: number;
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
  // Enforce minimum heartbeat cadence — automated clients ratchet rapidly,
  // real browsers are limited by the configured heartbeatIntervalSec (≥5s).
  // Score mild abuse if heartbeats arrive suspiciously fast.
  if (elapsedSec < 1) {
    // < 1 s: clear automation (UI can't fire that fast)
    addAbuse(s, 2, { signal: "heartbeat_invalid", detail: `cadence too fast: ${elapsedSec.toFixed(2)}s` });
    return { ok: false, reason: "cadence_violation" };
  }

  // Cap how fast playback time may advance between heartbeats — defeats heartbeat-forge walking.
  // Scale by declared playback rate so fast-forward (1.5x, 2x) users don't trip the cap.
  // Max 2.0 — matches the highest speed in any real video player UI. A forged
  // rate above 2.0 would still be capped here, limiting window walking to
  // elapsedSec*3.5+10 (e.g. 15s → 62.5s → 31 segments) even at declared 2x.
  const speed = Math.min(2.0, Math.max(1.0, input.playbackRate || 1.0));
  const maxAdvanceSec = elapsedSec * (speed * 1.5 + 0.5) + 10;
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
  // A rotated session is benign — the SID was replaced by a fresh one. The
  // client should be able to recover via /refresh-token or /rotate-session
  // instead of seeing the suspicious-activity overlay. Only flag as blocked
  // when revoked for a real abuse signal.
  const sig = (s.revokeReason as any)?.signal;
  const blocked = s.revoked && sig !== "rotated";
  return { breachCount: s.breachEvents, violationLimit: s.violationLimit, blocked, blockSecondsRemaining: remaining };
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
