import type { ResolvedPermissions, IntegrationClientConfig, IntegrationLaunchPayload } from "./types";
import type { VideoPlayerSettings, VideoSecuritySettings } from "@shared/schema";

const SERVER_AUTHORITATIVE_KEYS: (keyof ResolvedPermissions)[] = [
  "maxConcurrentSessions",
  "watermarkEnabled",
  "bannerEnabled",
];

export function resolvePermissions(
  clientConfig: IntegrationClientConfig,
  videoPlayerSettings: VideoPlayerSettings | null,
  videoSecuritySettings: VideoSecuritySettings | null,
  launchPayload: IntegrationLaunchPayload
): ResolvedPermissions {
  const base: ResolvedPermissions = {
    allowPlay: true,
    allowPause: true,
    allowSeek: videoPlayerSettings?.allowSkip ?? true,
    allowPlaybackRate: videoPlayerSettings?.allowSpeed ?? true,
    allowedRates: clientConfig.defaultAllowedRates || [0.5, 0.75, 1, 1.25, 1.5, 2],
    allowFullscreen: videoPlayerSettings?.allowFullscreen ?? clientConfig.defaultAllowFullscreen ?? true,
    allowPiP: true,
    showControls: clientConfig.defaultControls ?? true,
    autoplay: clientConfig.defaultAutoplay ?? false,
    startAt: videoPlayerSettings?.startTime ?? 0,
    completionThreshold: clientConfig.defaultCompletionThreshold ?? 90,
    watermarkEnabled: false,
    bannerEnabled: false,
    maxConcurrentSessions: videoSecuritySettings?.concurrentLimit ?? 5,
  };

  if (launchPayload.startAt !== undefined) {
    base.startAt = launchPayload.startAt;
  }

  if (launchPayload.permissions) {
    for (const [key, value] of Object.entries(launchPayload.permissions)) {
      if (SERVER_AUTHORITATIVE_KEYS.includes(key as keyof ResolvedPermissions)) continue;
      if (key in base && value !== undefined) {
        (base as any)[key] = value;
      }
    }
  }

  return base;
}
