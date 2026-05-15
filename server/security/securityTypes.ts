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
};

export const defaultClientSecuritySettings: ClientSecuritySettings = {
  blockVideoRecording: false,
  blockScreenshots: false,
  disableRightClick: false,
  blockDevTools: true,
  enableFocusMode: false,
  disableDownloads: false,
  requireFullscreen: false,
  antiScreenSharing: false,
  violationLimit: 3,
  allowedBrowsers: [],
  suspiciousDetectionEnabled: true,

  mediaSourceGuardEnabled: true,
  velocityScoringEnabled: true,
  keyBindingEnabled: true,
  heartbeatV2Enabled: true,
  serverGatedWindowEnabled: false,
  shortTokenTtlEnabled: false,
  tokenTtlPlaylistSec: 25,
  tokenTtlSegmentSec: 12,
  tokenTtlKeySec: 12,
  heartbeatIntervalSec: 12,
  downloadAheadLimit: 25,
  stealthModeEnabled: false,
};
