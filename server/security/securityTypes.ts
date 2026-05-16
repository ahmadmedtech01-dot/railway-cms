import { SECURITY_PROFILES, DEFAULT_SECURITY_PROFILE, type SecurityProfileId } from "@shared/securityProfiles";

export type ClientSecuritySettings = {
  blockVideoRecording: boolean;
  blockScreenshots: boolean;
  disableRightClick: boolean;
  blockDevTools: boolean;
  enableFocusMode: boolean;
  disableDownloads: boolean;
  requireFullscreen: boolean;
  antiScreenSharing: boolean;
  violationLimit: number;
  allowedBrowsers: string[];
  signedUrlTTLSeconds?: number;
  maxConcurrentSessions?: number;
  watermarkEnabled?: boolean;
  watermarkFields?: { name: boolean; email: boolean; userId: boolean; timestamp: boolean };
  maxPlaybackSpeed?: number;
  suspiciousDetectionEnabled?: boolean;

  // ── Advanced anti-downloader hardening (additive layers) ──────────────────
  mediaSourceGuardEnabled?: boolean;
  velocityScoringEnabled?: boolean;
  keyBindingEnabled?: boolean;
  heartbeatV2Enabled?: boolean;
  serverGatedWindowEnabled?: boolean;
  shortTokenTtlEnabled?: boolean;
  tokenTtlPlaylistSec?: number;
  tokenTtlSegmentSec?: number;
  tokenTtlKeySec?: number;
  heartbeatIntervalSec?: number;
  downloadAheadLimit?: number;
  stealthModeEnabled?: boolean;

  // ── Security Profile (preset selector + time-based tuning) ────────────────
  securityProfile?: SecurityProfileId;
  maxPrebufferSec?: number;
  maxDownloadAheadSec?: number;
  windowOverlapGraceSec?: number;
};

const BALANCED = SECURITY_PROFILES.balanced;

export const defaultClientSecuritySettings: ClientSecuritySettings = {
  blockVideoRecording: false,
  blockScreenshots: false,
  disableRightClick: false,
  blockDevTools: true,
  enableFocusMode: false,
  disableDownloads: false,
  requireFullscreen: false,
  antiScreenSharing: false,
  violationLimit: BALANCED.violationLimit,
  allowedBrowsers: [],
  suspiciousDetectionEnabled: true,

  mediaSourceGuardEnabled: true,
  velocityScoringEnabled: true,
  keyBindingEnabled: true,
  heartbeatV2Enabled: true,
  serverGatedWindowEnabled: false,
  shortTokenTtlEnabled: false,
  tokenTtlPlaylistSec: BALANCED.playlistTtlSec,
  tokenTtlSegmentSec: BALANCED.segmentTtlSec,
  tokenTtlKeySec: BALANCED.keyTtlSec,
  heartbeatIntervalSec: BALANCED.heartbeatIntervalSec,
  // downloadAheadLimit is segment-based; derived from maxDownloadAheadSec (60s @ ~2s/seg = 30).
  downloadAheadLimit: Math.ceil(BALANCED.maxDownloadAheadSec / 2),
  stealthModeEnabled: false,

  securityProfile: DEFAULT_SECURITY_PROFILE,
  maxPrebufferSec: BALANCED.maxPrebufferSec,
  maxDownloadAheadSec: BALANCED.maxDownloadAheadSec,
  windowOverlapGraceSec: BALANCED.windowOverlapGraceSec,
};
