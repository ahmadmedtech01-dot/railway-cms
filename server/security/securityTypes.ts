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
};
