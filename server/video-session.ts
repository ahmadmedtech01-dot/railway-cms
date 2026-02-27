import crypto from "crypto";

function resolveSecret(): string {
  if (process.env.SIGNING_SECRET) return process.env.SIGNING_SECRET;
  if (process.env.SESSION_SECRET) {
    return crypto.createHash("sha256").update("vcms-video-signing:" + process.env.SESSION_SECRET).digest("hex");
  }
  console.warn("[video-session] WARNING: No SIGNING_SECRET or SESSION_SECRET set — playback security degraded");
  return "insecure-dev-only-signing-key";
}

const SECRET = resolveSecret();

const SESSION_MAX_AGE_MS = 5 * 60 * 1000;
export const SESSION_ROTATION_MS = 3 * 60 * 1000;

const ABUSE_THRESHOLDS = {
  requestsPerWindow: 10,
  requestWindowMs: 1000,
  burstLimit: 15,
  concurrentSegments: 6,
  playlistFetchesPerMin: 30,
  keyHitsPerMin: 3,
  keyHitsTotal: 20,
  scoreToRevoke: 15,
  windowSize: 6,
  outOfWindowPenalty: 3,
};

const TOKEN_TTL = {
  manifest: 60,
  playlist: 60,
  segment: 10,
  key: 10,
};

export interface AbuseReason {
  signal: "rate_limit" | "concurrent" | "playlist_abuse" | "key_abuse" | "ip_mismatch" | "out_of_window" | "bulk_download";
  detail: string;
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
  storageProvider: "backblaze_b2" | "s3" | "local";
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
}

const sessions = new Map<string, VideoSession>();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now > s.expiresAt || s.createdAt < now - 30 * 60 * 1000) sessions.delete(id);
  }
}, 60 * 1000).unref();

export function computeDeviceHash(ua: string): string {
  return crypto.createHash("sha256").update(ua || "unknown-ua").digest("hex").slice(0, 16);
}

export function createSession(
  publicId: string,
  hlsPrefix: string,
  storageProvider: "backblaze_b2" | "s3" | "local",
  storageConfig: any,
  connId: string | null,
  deviceHash?: string,
  userAgent?: string,
): string {
  const sid = crypto.randomBytes(16).toString("hex");
  const uaHash = userAgent ? crypto.createHash("sha256").update(userAgent).digest("hex").slice(0, 32) : "";
  const keyExp = Math.floor(Date.now() / 1000) + Math.floor(SESSION_MAX_AGE_MS / 1000);
  const keySig = signPath(sid, "/key", keyExp, deviceHash || "");
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
  });
  return sid;
}

export function rotateSession(oldSid: string): string | null {
  const old = sessions.get(oldSid);
  if (!old || old.revoked) return null;

  const newSid = crypto.randomBytes(16).toString("hex");
  const keyExp = Math.floor(Date.now() / 1000) + Math.floor(SESSION_MAX_AGE_MS / 1000);
  const keySig = signPath(newSid, "/key", keyExp, old.deviceHash || "");

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
  });

  old.revoked = true;
  old.revokeReason = { signal: "rate_limit", detail: "Session rotated" };

  console.log(`[video-session] SESSION_ROTATED: oldSid=${oldSid} → newSid=${newSid}, publicId=${old.publicId}`);
  return newSid;
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

const VIOLATION_LIMIT = 6;
const BLOCK_DURATION_MS = 10 * 60 * 1000;

function addAbuse(s: VideoSession, delta: number, reason: AbuseReason): { abused: boolean } {
  s.abuseScore += delta;
  s.breachEvents += 1;

  if (s.breachEvents >= VIOLATION_LIMIT || s.abuseScore >= ABUSE_THRESHOLDS.scoreToRevoke) {
    s.revoked = true;
    s.blockedUntil = Date.now() + BLOCK_DURATION_MS;
    if (!s.revokeReason) s.revokeReason = reason;
    console.log(`[video-session] SECURITY_BULK_DOWNLOAD: Session ${reason.signal} — ${reason.detail}`);
    return { abused: true };
  }
  return { abused: false };
}

export function trackRequest(sid: string, ip?: string): { abused: boolean; reason?: AbuseReason } {
  const s = sessions.get(sid);
  if (!s) return { abused: true, reason: { signal: "rate_limit", detail: "Session not found" } };
  if (s.revoked) return { abused: true, reason: s.revokeReason ?? { signal: "rate_limit", detail: "Session revoked" } };

  if (Date.now() > s.expiresAt) {
    s.revoked = true;
    return { abused: true, reason: { signal: "rate_limit", detail: "Session expired" } };
  }

  if (ip) {
    if (!s.boundIp) {
      s.boundIp = ip;
    } else if (s.boundIp !== ip) {
      const reason: AbuseReason = { signal: "ip_mismatch", detail: `Session used from multiple IPs (${s.boundIp} → ${ip})` };
      return addAbuse(s, 8, reason);
    }
  }

  const now = Date.now();
  s.requestLog = s.requestLog.filter(t => t > now - ABUSE_THRESHOLDS.requestWindowMs);

  if (s.requestLog.length >= ABUSE_THRESHOLDS.burstLimit) {
    const reason: AbuseReason = { signal: "rate_limit", detail: `${s.requestLog.length + 1} requests in ${ABUSE_THRESHOLDS.requestWindowMs}ms (burst limit: ${ABUSE_THRESHOLDS.burstLimit})` };
    return addAbuse(s, 5, reason);
  }

  s.requestLog.push(now);

  if (s.requestLog.length > ABUSE_THRESHOLDS.requestsPerWindow) {
    const reason: AbuseReason = { signal: "rate_limit", detail: `${s.requestLog.length} requests in ${ABUSE_THRESHOLDS.requestWindowMs}ms (limit: ${ABUSE_THRESHOLDS.requestsPerWindow})` };
    return addAbuse(s, 3, reason);
  }

  return { abused: false };
}

export function trackPlaylistFetch(sid: string, ip?: string): { abused: boolean; reason?: AbuseReason } {
  const base = trackRequest(sid, ip);
  if (base.abused) return base;

  const s = sessions.get(sid)!;
  const now = Date.now();
  s.playlistFetchLog = s.playlistFetchLog.filter(t => t > now - 60000);
  s.playlistFetchLog.push(now);

  if (s.playlistFetchLog.length > ABUSE_THRESHOLDS.playlistFetchesPerMin) {
    const reason: AbuseReason = { signal: "playlist_abuse", detail: `${s.playlistFetchLog.length} playlist fetches in 60s (limit: ${ABUSE_THRESHOLDS.playlistFetchesPerMin})` };
    return addAbuse(s, 3, reason);
  }

  return { abused: false };
}

export function acquireSegment(sid: string, ip?: string): { abused: boolean; reason?: AbuseReason } {
  const base = trackRequest(sid, ip);
  if (base.abused) return base;

  const s = sessions.get(sid)!;
  s.concurrentSegments += 1;

  if (s.concurrentSegments > ABUSE_THRESHOLDS.concurrentSegments) {
    const reason: AbuseReason = { signal: "concurrent", detail: `${s.concurrentSegments} concurrent segment requests (limit: ${ABUSE_THRESHOLDS.concurrentSegments})` };
    s.concurrentSegments -= 1;
    return addAbuse(s, 5, reason);
  }

  const now = Date.now();
  s.segmentFetchLog = s.segmentFetchLog.filter(t => t > now - 5000);
  s.segmentFetchLog.push(now);

  if (s.segmentFetchLog.length > 30) {
    const reason: AbuseReason = { signal: "bulk_download", detail: `${s.segmentFetchLog.length} segments in 5s — bulk download detected` };
    console.log(`[video-session] SECURITY_BULK_DOWNLOAD: sid=${sid}, segments_in_5s=${s.segmentFetchLog.length}`);
    return addAbuse(s, 8, reason);
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

  if (s.keyHitLog.length > ABUSE_THRESHOLDS.keyHitsPerMin) {
    const reason: AbuseReason = { signal: "key_abuse", detail: `${s.keyHitLog.length} key requests in 60s (limit: ${ABUSE_THRESHOLDS.keyHitsPerMin}) — SECURITY_KEY_SPAM` };
    console.log(`[video-session] SECURITY_KEY_SPAM: sid=${sid}, hits_per_min=${s.keyHitLog.length}`);
    return addAbuse(s, 5, reason);
  }

  if (s.keyIssuedCount > ABUSE_THRESHOLDS.keyHitsTotal) {
    const reason: AbuseReason = { signal: "key_abuse", detail: `${s.keyIssuedCount} total key requests this session (limit: ${ABUSE_THRESHOLDS.keyHitsTotal}) — SECURITY_KEY_REPLAY` };
    console.log(`[video-session] SECURITY_KEY_REPLAY: sid=${sid}, total_issued=${s.keyIssuedCount}`);
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

export function buildSignedProxyUrl(baseUrl: string, sid: string, resourcePath: string, ttlSeconds: number, deviceHash?: string): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const st = signPath(sid, resourcePath, exp, deviceHash);
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}sid=${encodeURIComponent(sid)}&st=${encodeURIComponent(st)}&exp=${exp}`;
}

export function buildStableKeyUrl(baseUrl: string, sid: string, session: VideoSession): string {
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}sid=${encodeURIComponent(sid)}&st=${encodeURIComponent(session.keySig)}&exp=${session.keyExp}`;
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

  const { start, end } = getWindowRange(sid);

  if (segIndex >= start && segIndex <= end) {
    if (segIndex > s.currentSegmentIndex) {
      s.currentSegmentIndex = segIndex;
    }
    return { allowed: true };
  }

  s.outOfWindowCount += 1;
  if (s.outOfWindowCount >= 3) {
    const reason: AbuseReason = { signal: "out_of_window", detail: `Segment ${segIndex} outside window [${start},${end}] (${s.outOfWindowCount} violations)` };
    return { allowed: !addAbuse(s, ABUSE_THRESHOLDS.outOfWindowPenalty, reason).abused, reason };
  }

  return { allowed: true };
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
    violationLimit: VIOLATION_LIMIT,
    blockedUntil: s.blockedUntil,
    concurrentSegments: s.concurrentSegments,
    recentRequests: s.requestLog.length,
    playlistFetches: s.playlistFetchLog.length,
    keyHits: s.keyHitLog.length,
    keyIssuedCount: s.keyIssuedCount,
    boundIp: s.boundIp,
    currentSegmentIndex: s.currentSegmentIndex,
    outOfWindowCount: s.outOfWindowCount,
  };
}

export function getBreachInfo(sid: string): { breachCount: number; violationLimit: number; blocked: boolean; blockSecondsRemaining: number } {
  const s = sessions.get(sid);
  if (!s) return { breachCount: 0, violationLimit: VIOLATION_LIMIT, blocked: true, blockSecondsRemaining: 0 };
  const remaining = s.blockedUntil ? Math.max(0, Math.ceil((s.blockedUntil - Date.now()) / 1000)) : 0;
  return { breachCount: s.breachEvents, violationLimit: VIOLATION_LIMIT, blocked: s.revoked, blockSecondsRemaining: remaining };
}

export function getAbuseThresholds() {
  return { ...ABUSE_THRESHOLDS };
}

export function getTokenTTL() {
  return { ...TOKEN_TTL };
}

export function getAllSessions() {
  return sessions;
}
