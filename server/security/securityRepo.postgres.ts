import { db } from "../db";
import { systemSettings, videoClientSecurity } from "@shared/schema";
import { eq } from "drizzle-orm";
import type { SecurityRepo } from "./securityRepo";
import { defaultClientSecuritySettings, type ClientSecuritySettings } from "./securityTypes";

const GLOBAL_KEY = "security:global";

export class PostgresSecurityRepo implements SecurityRepo {
  async getGlobal(): Promise<ClientSecuritySettings> {
    const [row] = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, GLOBAL_KEY));

    if (!row?.value) {
      const defaults = { ...defaultClientSecuritySettings };
      await this.saveGlobal(defaults);
      return defaults;
    }

    try {
      return { ...defaultClientSecuritySettings, ...JSON.parse(row.value) } as ClientSecuritySettings;
    } catch {
      return { ...defaultClientSecuritySettings };
    }
  }

  async saveGlobal(settings: ClientSecuritySettings): Promise<void> {
    const value = JSON.stringify(settings);
    await db
      .insert(systemSettings)
      .values({ key: GLOBAL_KEY, value })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedAt: new Date() } });
  }

  async getVideo(videoId: string): Promise<ClientSecuritySettings | null> {
    const [row] = await db
      .select()
      .from(videoClientSecurity)
      .where(eq(videoClientSecurity.videoId, videoId));

    if (!row) return null;

    return {
      blockVideoRecording: row.blockVideoRecording,
      blockScreenshots: row.blockScreenshots,
      disableRightClick: row.disableRightClick,
      blockDevTools: row.blockDevTools,
      enableFocusMode: row.enableFocusMode,
      disableDownloads: row.disableDownloads,
      requireFullscreen: row.requireFullscreen,
      antiScreenSharing: row.antiScreenSharing,
      suspiciousDetectionEnabled: row.suspiciousDetectionEnabled,
      violationLimit: row.violationLimit,
      allowedBrowsers: row.allowedBrowsers ?? [],
    };
  }

  async saveVideo(videoId: string, settings: ClientSecuritySettings): Promise<void> {
    const existing = await db
      .select({ id: videoClientSecurity.id })
      .from(videoClientSecurity)
      .where(eq(videoClientSecurity.videoId, videoId));

    const data = {
      blockVideoRecording: settings.blockVideoRecording,
      blockScreenshots: settings.blockScreenshots,
      disableRightClick: settings.disableRightClick,
      blockDevTools: settings.blockDevTools,
      enableFocusMode: settings.enableFocusMode,
      disableDownloads: settings.disableDownloads,
      requireFullscreen: settings.requireFullscreen,
      antiScreenSharing: settings.antiScreenSharing,
      suspiciousDetectionEnabled: settings.suspiciousDetectionEnabled ?? true,
      violationLimit: settings.violationLimit,
      allowedBrowsers: settings.allowedBrowsers,
    };

    if (existing.length > 0) {
      await db
        .update(videoClientSecurity)
        .set(data)
        .where(eq(videoClientSecurity.videoId, videoId));
    } else {
      await db.insert(videoClientSecurity).values({ videoId, ...data });
    }
  }

  async getUseGlobal(videoId: string): Promise<boolean> {
    const [row] = await db
      .select({ useGlobal: videoClientSecurity.useGlobal })
      .from(videoClientSecurity)
      .where(eq(videoClientSecurity.videoId, videoId));

    return row?.useGlobal ?? true;
  }

  async setUseGlobal(videoId: string, useGlobal: boolean): Promise<void> {
    const existing = await db
      .select({ id: videoClientSecurity.id })
      .from(videoClientSecurity)
      .where(eq(videoClientSecurity.videoId, videoId));

    if (existing.length > 0) {
      await db
        .update(videoClientSecurity)
        .set({ useGlobal })
        .where(eq(videoClientSecurity.videoId, videoId));
    } else {
      await db.insert(videoClientSecurity).values({
        videoId,
        useGlobal,
        ...defaultClientSecuritySettings,
      });
    }
  }
}
