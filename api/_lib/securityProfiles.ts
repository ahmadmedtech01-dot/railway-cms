// ── Security Profile Presets ────────────────────────────────────────────────
// Scalable, admin-configurable security profiles for 700-1000 concurrent LMS
// students. Admins pick a preset OR fully customize every value.
// Balanced is the recommended default.

export type SecurityProfileId = "compatibility" | "balanced" | "strict" | "custom";

export interface SecurityProfileValues {
  heartbeatIntervalSec: number;
  playlistTtlSec: number;
  segmentTtlSec: number;
  keyTtlSec: number;
  maxPrebufferSec: number;
  maxDownloadAheadSec: number;
  windowOverlapGraceSec: number;
  violationLimit: number;
}

export const SECURITY_PROFILES: Record<Exclude<SecurityProfileId, "custom">, SecurityProfileValues> = {
  compatibility: {
    heartbeatIntervalSec: 25,
    playlistTtlSec: 120,
    segmentTtlSec: 60,
    keyTtlSec: 60,
    maxPrebufferSec: 60,
    maxDownloadAheadSec: 120,
    windowOverlapGraceSec: 45,
    violationLimit: 15,
  },
  balanced: {
    heartbeatIntervalSec: 15,
    playlistTtlSec: 60,
    segmentTtlSec: 30,
    keyTtlSec: 30,
    maxPrebufferSec: 45,
    maxDownloadAheadSec: 60,
    windowOverlapGraceSec: 30,
    violationLimit: 10,
  },
  strict: {
    heartbeatIntervalSec: 10,
    playlistTtlSec: 30,
    segmentTtlSec: 15,
    keyTtlSec: 15,
    maxPrebufferSec: 30,
    maxDownloadAheadSec: 30,
    windowOverlapGraceSec: 20,
    violationLimit: 6,
  },
};

export const SECURITY_PROFILE_LABELS: Record<SecurityProfileId, string> = {
  compatibility: "Compatibility Mode",
  balanced: "Balanced Secure Mode",
  strict: "Strict Anti-Download Mode",
  custom: "Custom",
};

export const SECURITY_PROFILE_DESCRIPTIONS: Record<SecurityProfileId, string> = {
  compatibility: "Maximum playback compatibility. Longer TTLs, fewer heartbeats — best for slow networks and high-concurrency LMS rooms (700-1000+ students).",
  balanced: "Recommended default. Strong protection with smooth playback for most environments.",
  strict: "Highest anti-download protection. Short TTLs, frequent heartbeats — may cause more 403s on slow networks.",
  custom: "Manually tuned values. Each field below can be edited independently.",
};

export const DEFAULT_SECURITY_PROFILE: SecurityProfileId = "balanced";

// Helper: returns true if the provided values exactly match a preset.
export function detectProfile(values: Partial<SecurityProfileValues>): SecurityProfileId {
  for (const id of ["compatibility", "balanced", "strict"] as const) {
    const p = SECURITY_PROFILES[id];
    if (
      values.heartbeatIntervalSec === p.heartbeatIntervalSec &&
      values.playlistTtlSec === p.playlistTtlSec &&
      values.segmentTtlSec === p.segmentTtlSec &&
      values.keyTtlSec === p.keyTtlSec &&
      values.maxPrebufferSec === p.maxPrebufferSec &&
      values.maxDownloadAheadSec === p.maxDownloadAheadSec &&
      values.windowOverlapGraceSec === p.windowOverlapGraceSec &&
      values.violationLimit === p.violationLimit
    ) {
      return id;
    }
  }
  return "custom";
}
