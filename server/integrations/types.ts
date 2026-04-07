export interface IntegrationLaunchPayload {
  iss: string;
  aud: string;
  sub: string;
  publicId: string;
  courseId?: string;
  lessonId?: string;
  sessionId?: string;
  name?: string;
  email?: string;
  permissions?: Partial<ResolvedPermissions>;
  startAt?: number;
  origin?: string;
  exp: number;
  iat: number;
  jti: string;
}

export interface IntegrationMintRequest {
  launchToken: string;
  context?: {
    courseId?: string;
    lessonId?: string;
    sessionId?: string;
    origin?: string;
  };
}

export interface IntegrationMintResponse {
  ok: true;
  integrationSessionId: string;
  embedToken: string;
  expiresIn: number;
  manifestUrl: string;
  refreshUrl: string;
  pingUrl: string;
  eventUrl: string;
  metadata: {
    title: string;
    durationSeconds: number | null;
    posterUrl: string | null;
    publicId: string;
  };
  playerConfig: ResolvedPermissions;
}

export interface IntegrationRefreshRequest {
  integrationSessionId: string;
  embedToken: string;
}

export interface IntegrationPingRequest {
  integrationSessionId: string;
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  playbackRate?: number;
  buffering?: boolean;
}

export interface IntegrationEventRequest {
  integrationSessionId: string;
  events: Array<{
    type: string;
    time: number;
    payload?: Record<string, unknown>;
  }>;
}

export interface IntegrationCompleteRequest {
  integrationSessionId: string;
  completionPercent: number;
}

export interface ResolvedPermissions {
  allowPlay: boolean;
  allowPause: boolean;
  allowSeek: boolean;
  allowPlaybackRate: boolean;
  allowedRates: number[];
  allowFullscreen: boolean;
  allowPiP: boolean;
  showControls: boolean;
  autoplay: boolean;
  startAt: number;
  completionThreshold: number;
  watermarkEnabled: boolean;
  bannerEnabled: boolean;
  maxConcurrentSessions: number;
}

export interface IntegrationErrorResponse {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type IntegrationClientConfig = {
  defaultAutoplay?: boolean;
  defaultControls?: boolean;
  defaultAllowFullscreen?: boolean;
  defaultAllowedRates?: number[];
  defaultTheme?: string;
  allowIframeEmbed?: boolean;
  allowSdkEmbed?: boolean;
  allowReactEmbed?: boolean;
  allowProgressWriteback?: boolean;
  defaultCompletionThreshold?: number;
  strictOriginCheck?: boolean;
};
