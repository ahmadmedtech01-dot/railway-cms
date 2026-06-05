import { db } from "./db";
import {
  adminUsers, videos, videoPlayerSettings, videoWatermarkSettings,
  videoSecuritySettings, embedTokens, playbackSessions, auditLogs, systemSettings, storageConnections, mediaAssets, videoBanners,
  integrationClients, integrationClientVideoAccess, integrationLaunchLogs, integrationPlaybackSessions, integrationEventLogs, integrationApiKeys,
  videoShareLinks, videoCategories,
  type AdminUser, type Video, type VideoPlayerSettings, type VideoWatermarkSettings,
  type VideoSecuritySettings, type EmbedToken, type PlaybackSession, type AuditLog,
  type SystemSetting, type StorageConnection, type MediaAsset, type VideoBanner,
  type IntegrationClient, type IntegrationClientVideoAccess, type IntegrationLaunchLog,
  type IntegrationPlaybackSession, type IntegrationEventLog, type IntegrationApiKey,
  type VideoShareLink, type VideoCategory,
} from "@shared/schema";
import { eq, desc, and, sql, asc, like, inArray, lt } from "drizzle-orm";

export const storage = {
  // Admin
  async getAdminByEmail(email: string): Promise<AdminUser | undefined> {
    const [admin] = await db.select().from(adminUsers).where(eq(adminUsers.email, email));
    return admin;
  },

  async createAdminUser(email: string, passwordHash: string): Promise<AdminUser> {
    const [admin] = await db.insert(adminUsers).values({ email, passwordHash }).returning();
    return admin;
  },

  // Videos
  async getVideos(): Promise<Video[]> {
    return db.select().from(videos).orderBy(desc(videos.createdAt));
  },

  async getVideoById(id: string): Promise<Video | undefined> {
    const [v] = await db.select().from(videos).where(eq(videos.id, id));
    return v;
  },

  async getVideoByPublicId(publicId: string): Promise<Video | undefined> {
    const [v] = await db.select().from(videos).where(eq(videos.publicId, publicId));
    return v;
  },

  async createVideo(data: Partial<Video>): Promise<Video> {
    const [v] = await db.insert(videos).values(data as any).returning();
    return v;
  },

  async updateVideo(id: string, data: Partial<Video>): Promise<Video | undefined> {
    const [v] = await db
      .update(videos)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(videos.id, id))
      .returning();
    return v;
  },

  async deleteVideo(id: string): Promise<void> {
    await db.delete(videos).where(eq(videos.id, id));
  },

  // Player Settings
  async getPlayerSettings(videoId: string): Promise<VideoPlayerSettings | undefined> {
    const [s] = await db.select().from(videoPlayerSettings).where(eq(videoPlayerSettings.videoId, videoId));
    return s;
  },

  async upsertPlayerSettings(videoId: string, data: Partial<VideoPlayerSettings>): Promise<VideoPlayerSettings> {
    const existing = await this.getPlayerSettings(videoId);
    if (existing) {
      const [s] = await db.update(videoPlayerSettings).set(data).where(eq(videoPlayerSettings.videoId, videoId)).returning();
      return s;
    } else {
      const [s] = await db.insert(videoPlayerSettings).values({ videoId, ...data } as any).returning();
      return s;
    }
  },

  // Watermark Settings
  async getWatermarkSettings(videoId: string): Promise<VideoWatermarkSettings | undefined> {
    const [s] = await db.select().from(videoWatermarkSettings).where(eq(videoWatermarkSettings.videoId, videoId));
    return s;
  },

  async upsertWatermarkSettings(videoId: string, data: Partial<VideoWatermarkSettings>): Promise<VideoWatermarkSettings> {
    const existing = await this.getWatermarkSettings(videoId);
    if (existing) {
      const [s] = await db.update(videoWatermarkSettings).set(data).where(eq(videoWatermarkSettings.videoId, videoId)).returning();
      return s;
    } else {
      const [s] = await db.insert(videoWatermarkSettings).values({ videoId, ...data } as any).returning();
      return s;
    }
  },

  // Security Settings
  async getSecuritySettings(videoId: string): Promise<VideoSecuritySettings | undefined> {
    const [s] = await db.select().from(videoSecuritySettings).where(eq(videoSecuritySettings.videoId, videoId));
    return s;
  },

  async upsertSecuritySettings(videoId: string, data: Partial<VideoSecuritySettings>): Promise<VideoSecuritySettings> {
    const existing = await this.getSecuritySettings(videoId);
    if (existing) {
      const [s] = await db.update(videoSecuritySettings).set(data).where(eq(videoSecuritySettings.videoId, videoId)).returning();
      return s;
    } else {
      const [s] = await db.insert(videoSecuritySettings).values({ videoId, ...data } as any).returning();
      return s;
    }
  },

  // Embed Tokens
  async createEmbedToken(data: Partial<EmbedToken>): Promise<EmbedToken> {
    const [t] = await db.insert(embedTokens).values(data as any).returning();
    return t;
  },

  async getEmbedTokensByVideo(videoId: string): Promise<EmbedToken[]> {
    return db.select().from(embedTokens).where(eq(embedTokens.videoId, videoId)).orderBy(desc(embedTokens.createdAt));
  },

  async getAllTokens(): Promise<EmbedToken[]> {
    return db.select().from(embedTokens).orderBy(desc(embedTokens.createdAt));
  },

  async getTokenByValue(token: string): Promise<EmbedToken | undefined> {
    const [t] = await db.select().from(embedTokens).where(eq(embedTokens.token, token));
    return t;
  },

  async revokeToken(id: string): Promise<void> {
    await db.update(embedTokens).set({ revoked: true }).where(eq(embedTokens.id, id));
  },

  async deleteToken(id: string): Promise<void> {
    await db.delete(embedTokens).where(eq(embedTokens.id, id));
  },

  async deleteExpiredTokensOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = await db.delete(embedTokens)
      .where(and(
        lt(embedTokens.expiresAt, cutoff),
      ))
      .returning({ id: embedTokens.id });
    return result.length;
  },

  // Per-user token helpers — for LMS / per-student token minting
  async getActiveUserTokens(videoId: string, userId: string): Promise<EmbedToken[]> {
    const all = await db
      .select()
      .from(embedTokens)
      .where(and(eq(embedTokens.videoId, videoId), eq(embedTokens.userId as any, userId)));
    const now = new Date();
    return all.filter(t => !t.revoked && (!t.expiresAt || t.expiresAt > now));
  },

  async revokeUserTokensByInstId(videoId: string, userId: string, instId: string): Promise<number> {
    const tokens = await this.getActiveUserTokens(videoId, userId);
    const toRevoke = tokens.filter(t => (t as any).label?.includes(`:inst:${instId}`));
    for (const t of toRevoke) {
      await db.update(embedTokens).set({ revoked: true }).where(eq(embedTokens.id, t.id));
    }
    return toRevoke.length;
  },

  async revokeAllUserTokens(videoId: string, userId: string): Promise<number> {
    const tokens = await this.getActiveUserTokens(videoId, userId);
    for (const t of tokens) {
      await db.update(embedTokens).set({ revoked: true }).where(eq(embedTokens.id, t.id));
    }
    return tokens.length;
  },

  async revokeUserTokensExcept(videoId: string, userId: string, exceptTokenValue: string): Promise<void> {
    const tokens = await this.getActiveUserTokens(videoId, userId);
    for (const t of tokens) {
      if (t.token !== exceptTokenValue) {
        await db.update(embedTokens).set({ revoked: true }).where(eq(embedTokens.id, t.id));
      }
    }
  },

  // Video Share Links (short, clean public URLs — no JWT in URL)
  async getShareLinkByVideoId(videoId: string): Promise<VideoShareLink | undefined> {
    const [s] = await db.select().from(videoShareLinks).where(eq(videoShareLinks.videoId, videoId));
    return s;
  },

  async getShareLinkByCode(shareCode: string): Promise<VideoShareLink | undefined> {
    const [s] = await db.select().from(videoShareLinks).where(eq(videoShareLinks.shareCode, shareCode));
    return s;
  },

  async upsertShareLink(videoId: string, data: Partial<VideoShareLink> & { shareCode: string }): Promise<VideoShareLink> {
    const existing = await this.getShareLinkByVideoId(videoId);
    if (existing) {
      const [s] = await db.update(videoShareLinks)
        .set({ ...data, videoId } as any)
        .where(eq(videoShareLinks.videoId, videoId))
        .returning();
      return s;
    }
    const [s] = await db.insert(videoShareLinks).values({ videoId, ...data } as any).returning();
    return s;
  },

  async updateShareLink(videoId: string, data: Partial<VideoShareLink>): Promise<VideoShareLink | undefined> {
    const [s] = await db.update(videoShareLinks)
      .set(data as any)
      .where(eq(videoShareLinks.videoId, videoId))
      .returning();
    return s;
  },

  async revokeShareLink(videoId: string): Promise<void> {
    await db.update(videoShareLinks)
      .set({ isActive: false, revokedAt: new Date() })
      .where(eq(videoShareLinks.videoId, videoId));
  },

  async deleteShareLink(videoId: string): Promise<void> {
    await db.delete(videoShareLinks).where(eq(videoShareLinks.videoId, videoId));
  },

  async incrementShareLinkViews(videoId: string): Promise<void> {
    await db.update(videoShareLinks)
      .set({ viewCount: sql`${videoShareLinks.viewCount} + 1` as any })
      .where(eq(videoShareLinks.videoId, videoId));
  },

  // Revoke all active embed_tokens minted from share links for this video.
  // Optionally narrow to a specific shareCode label suffix.
  async revokeShareEmbedTokens(videoId: string, shareCode?: string): Promise<number> {
    const all = await db.select().from(embedTokens).where(eq(embedTokens.videoId, videoId));
    const prefix = shareCode ? `share:${shareCode}` : "share:";
    const targets = all.filter(t => !t.revoked && (t.label || "").startsWith(prefix));
    for (const t of targets) {
      await db.update(embedTokens).set({ revoked: true }).where(eq(embedTokens.id, t.id));
    }
    return targets.length;
  },

  // Playback Sessions
  async createSession(data: Partial<PlaybackSession>): Promise<PlaybackSession> {
    const [s] = await db.insert(playbackSessions).values(data as any).returning();
    return s;
  },

  async pingSession(sessionCode: string, secondsWatched: number): Promise<void> {
    await db.update(playbackSessions)
      .set({ lastSeenAt: new Date(), secondsWatched })
      .where(eq(playbackSessions.sessionCode, sessionCode));
  },

  async getSessionsByVideo(videoId: string): Promise<PlaybackSession[]> {
    return db.select().from(playbackSessions)
      .where(eq(playbackSessions.videoId, videoId))
      .orderBy(desc(playbackSessions.startedAt))
      .limit(50);
  },

  async getVideoAnalytics(videoId: string) {
    const sessions = await this.getSessionsByVideo(videoId);
    const totalPlays = sessions.length;
    const totalWatchSeconds = sessions.reduce((a, s) => a + (s.secondsWatched || 0), 0);
    const uniqueDomains = [...new Set(sessions.map(s => s.domain).filter(Boolean))];
    const domainCounts: Record<string, number> = {};
    sessions.forEach(s => {
      if (s.domain) domainCounts[s.domain] = (domainCounts[s.domain] || 0) + 1;
    });
    const topDomains = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    return { totalPlays, totalWatchSeconds, uniqueDomains: uniqueDomains.length, topDomains, recentSessions: sessions.slice(0, 20) };
  },

  // Audit Logs
  async createAuditLog(data: { action: string; meta?: any; ip?: string }): Promise<void> {
    await db.insert(auditLogs).values(data as any);
  },

  async getAuditLogs(): Promise<AuditLog[]> {
    return db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(100);
  },

  // System Settings
  async getSetting(key: string): Promise<string | null> {
    const [s] = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
    return s?.value ?? null;
  },

  async getAllSettings(): Promise<SystemSetting[]> {
    return db.select().from(systemSettings);
  },

  async setSetting(key: string, value: string): Promise<void> {
    const existing = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
    if (existing.length > 0) {
      await db.update(systemSettings).set({ value, updatedAt: new Date() }).where(eq(systemSettings.key, key));
    } else {
      await db.insert(systemSettings).values({ key, value });
    }
  },

  async setSettings(data: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(data)) {
      await this.setSetting(key, value);
    }
  },

  // Storage Connections
  async getStorageConnections(): Promise<StorageConnection[]> {
    return db.select().from(storageConnections).orderBy(desc(storageConnections.createdAt));
  },

  async getStorageConnectionById(id: string): Promise<StorageConnection | undefined> {
    const [c] = await db.select().from(storageConnections).where(eq(storageConnections.id, id));
    return c;
  },

  async getActiveStorageConnection(): Promise<StorageConnection | undefined> {
    const [c] = await db.select().from(storageConnections).where(eq(storageConnections.isActive, true));
    return c;
  },

  async createStorageConnection(data: Omit<StorageConnection, "id" | "createdAt">): Promise<StorageConnection> {
    const [c] = await db.insert(storageConnections).values(data as any).returning();
    return c;
  },

  async updateStorageConnection(id: string, data: Partial<StorageConnection>): Promise<StorageConnection | undefined> {
    const [c] = await db.update(storageConnections).set(data as any).where(eq(storageConnections.id, id)).returning();
    return c;
  },

  async deleteStorageConnection(id: string): Promise<void> {
    await db.delete(storageConnections).where(eq(storageConnections.id, id));
  },

  async setActiveStorageConnection(id: string): Promise<void> {
    await db.update(storageConnections).set({ isActive: false });
    await db.update(storageConnections).set({ isActive: true }).where(eq(storageConnections.id, id));
  },

  async createMediaAsset(data: { type: string; bucketKey: string; originalName: string; mimeType: string; storageConnectionId?: string | null }): Promise<MediaAsset> {
    const [a] = await db.insert(mediaAssets).values(data as any).returning();
    return a;
  },

  async getMediaAssetById(id: string): Promise<MediaAsset | undefined> {
    const [a] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, id));
    return a;
  },

  async getMediaAssets(): Promise<MediaAsset[]> {
    return db.select().from(mediaAssets).orderBy(desc(mediaAssets.createdAt));
  },

  async deleteMediaAssetsByVideoId(videoId: string): Promise<void> {
    await db.delete(mediaAssets).where(like(mediaAssets.bucketKey, `assets/videos/${videoId}/%`));
  },

  // Banners
  async getBannersByVideo(videoId: string): Promise<VideoBanner[]> {
    return db.select().from(videoBanners)
      .where(eq(videoBanners.videoId, videoId))
      .orderBy(asc(videoBanners.sortOrder), asc(videoBanners.createdAt));
  },

  async createBanner(data: Partial<VideoBanner>): Promise<VideoBanner> {
    const [b] = await db.insert(videoBanners).values(data as any).returning();
    return b;
  },

  async updateBanner(id: string, data: Partial<VideoBanner>): Promise<VideoBanner | undefined> {
    const [b] = await db.update(videoBanners)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(videoBanners.id, id))
      .returning();
    return b;
  },

  async deleteBanner(id: string): Promise<void> {
    await db.delete(videoBanners).where(eq(videoBanners.id, id));
  },

  async reorderBanners(videoId: string, orderedIds: string[]): Promise<void> {
    for (let i = 0; i < orderedIds.length; i++) {
      await db.update(videoBanners)
        .set({ sortOrder: i })
        .where(and(eq(videoBanners.id, orderedIds[i]), eq(videoBanners.videoId, videoId)));
    }
  },

  // Integration Clients
  async createIntegrationClient(data: Partial<IntegrationClient>): Promise<IntegrationClient> {
    const [c] = await db.insert(integrationClients).values(data as any).returning();
    return c;
  },

  async getIntegrationClients(): Promise<IntegrationClient[]> {
    return db.select().from(integrationClients).orderBy(desc(integrationClients.createdAt));
  },

  async getIntegrationClientById(id: string): Promise<IntegrationClient | undefined> {
    const [c] = await db.select().from(integrationClients).where(eq(integrationClients.id, id));
    return c;
  },

  async getIntegrationClientByKey(clientKey: string): Promise<IntegrationClient | undefined> {
    const [c] = await db.select().from(integrationClients).where(eq(integrationClients.clientKey, clientKey));
    return c;
  },

  async getIntegrationClientBySlug(slug: string): Promise<IntegrationClient | undefined> {
    const [c] = await db.select().from(integrationClients).where(eq(integrationClients.slug, slug));
    return c;
  },

  async updateIntegrationClient(id: string, data: Partial<IntegrationClient>): Promise<IntegrationClient | undefined> {
    const [c] = await db.update(integrationClients)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(integrationClients.id, id))
      .returning();
    return c;
  },

  async deleteIntegrationClient(id: string): Promise<void> {
    await db.delete(integrationClients).where(eq(integrationClients.id, id));
  },

  // Integration Client Video Access
  async getClientVideoAccess(clientId: string): Promise<IntegrationClientVideoAccess[]> {
    return db.select().from(integrationClientVideoAccess)
      .where(eq(integrationClientVideoAccess.integrationClientId, clientId));
  },

  async setClientVideoAccess(clientId: string, videoIds: string[]): Promise<void> {
    await db.delete(integrationClientVideoAccess)
      .where(eq(integrationClientVideoAccess.integrationClientId, clientId));
    if (videoIds.length > 0) {
      await db.insert(integrationClientVideoAccess)
        .values(videoIds.map(videoId => ({ integrationClientId: clientId, videoId })));
    }
  },

  async isVideoAllowedForClient(clientId: string, videoId: string, mode: string): Promise<boolean> {
    if (mode === "all") return true;
    const [access] = await db.select().from(integrationClientVideoAccess)
      .where(and(
        eq(integrationClientVideoAccess.integrationClientId, clientId),
        eq(integrationClientVideoAccess.videoId, videoId)
      ));
    return !!access;
  },

  // Integration Launch Logs
  async createLaunchLog(data: Partial<IntegrationLaunchLog>): Promise<IntegrationLaunchLog> {
    const [l] = await db.insert(integrationLaunchLogs).values(data as any).returning();
    return l;
  },

  async getLaunchLogs(limit = 100, offset = 0, filters?: { clientId?: string; status?: string; publicId?: string; lmsUserId?: string }): Promise<{ logs: IntegrationLaunchLog[]; total: number }> {
    let conditions: any[] = [];
    if (filters?.clientId) conditions.push(eq(integrationLaunchLogs.integrationClientId, filters.clientId));
    if (filters?.status) conditions.push(eq(integrationLaunchLogs.status, filters.status));
    if (filters?.publicId) conditions.push(eq(integrationLaunchLogs.publicId, filters.publicId));
    if (filters?.lmsUserId) conditions.push(eq(integrationLaunchLogs.lmsUserId, filters.lmsUserId));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(integrationLaunchLogs).where(where);
    const logs = await db.select().from(integrationLaunchLogs)
      .where(where)
      .orderBy(desc(integrationLaunchLogs.createdAt))
      .limit(limit)
      .offset(offset);

    return { logs, total: Number(countResult?.count || 0) };
  },

  // Integration Playback Sessions
  async createIntegrationPlaybackSession(data: Partial<IntegrationPlaybackSession>): Promise<IntegrationPlaybackSession> {
    const [s] = await db.insert(integrationPlaybackSessions).values(data as any).returning();
    return s;
  },

  async getIntegrationPlaybackSessionById(id: string): Promise<IntegrationPlaybackSession | undefined> {
    const [s] = await db.select().from(integrationPlaybackSessions).where(eq(integrationPlaybackSessions.id, id));
    return s;
  },

  async updateIntegrationPlaybackSession(id: string, data: Partial<IntegrationPlaybackSession>): Promise<IntegrationPlaybackSession | undefined> {
    const [s] = await db.update(integrationPlaybackSessions)
      .set(data as any)
      .where(eq(integrationPlaybackSessions.id, id))
      .returning();
    return s;
  },

  // Fire-and-forget: advance maxPositionSeconds using GREATEST so seek-back
  // never overwrites a larger value. Called from the /tick handler so position
  // is always persisted even when the LMS ping omits currentTime.
  async touchIntegrationSessionPosition(id: string, seconds: number): Promise<void> {
    await db.update(integrationPlaybackSessions)
      .set({
        maxPositionSeconds: sql`GREATEST(max_position_seconds, ${Math.floor(seconds)})`,
        lastPingAt: new Date(),
      })
      .where(eq(integrationPlaybackSessions.id, id));
  },

  async getLatestIntegrationPlaybackSessionForUser(publicId: string, lmsUserId: string, clientId: string): Promise<IntegrationPlaybackSession | undefined> {
    const [s] = await db.select().from(integrationPlaybackSessions)
      .where(and(
        eq(integrationPlaybackSessions.publicId, publicId),
        eq(integrationPlaybackSessions.lmsUserId, lmsUserId),
        eq(integrationPlaybackSessions.integrationClientId, clientId),
      ))
      .orderBy(desc(integrationPlaybackSessions.startedAt))
      .limit(1);
    return s;
  },

  async getIntegrationPlaybackSessions(limit = 100, offset = 0, filters?: { clientId?: string; status?: string; publicId?: string; lmsUserId?: string }): Promise<{ sessions: IntegrationPlaybackSession[]; total: number }> {
    let conditions: any[] = [];
    if (filters?.clientId) conditions.push(eq(integrationPlaybackSessions.integrationClientId, filters.clientId));
    if (filters?.status) conditions.push(eq(integrationPlaybackSessions.status, filters.status));
    if (filters?.publicId) conditions.push(eq(integrationPlaybackSessions.publicId, filters.publicId));
    if (filters?.lmsUserId) conditions.push(eq(integrationPlaybackSessions.lmsUserId, filters.lmsUserId));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(integrationPlaybackSessions).where(where);
    const sessions = await db.select().from(integrationPlaybackSessions)
      .where(where)
      .orderBy(desc(integrationPlaybackSessions.startedAt))
      .limit(limit)
      .offset(offset);

    return { sessions, total: Number(countResult?.count || 0) };
  },

  // Integration Event Logs
  async createIntegrationEvents(sessionId: string, events: Array<{ eventType: string; eventTimeSeconds?: string; payload?: any }>): Promise<void> {
    if (events.length === 0) return;
    await db.insert(integrationEventLogs).values(
      events.map(e => ({
        integrationPlaybackSessionId: sessionId,
        eventType: e.eventType,
        eventTimeSeconds: e.eventTimeSeconds || null,
        payload: e.payload || {},
      }))
    );
  },

  async getIntegrationEvents(sessionId: string): Promise<IntegrationEventLog[]> {
    return db.select().from(integrationEventLogs)
      .where(eq(integrationEventLogs.integrationPlaybackSessionId, sessionId))
      .orderBy(asc(integrationEventLogs.createdAt));
  },

  // Video Categories
  async getCategories(): Promise<VideoCategory[]> {
    return db.select().from(videoCategories).orderBy(asc(videoCategories.name));
  },

  async getCategoryById(id: string): Promise<VideoCategory | undefined> {
    const [c] = await db.select().from(videoCategories).where(eq(videoCategories.id, id));
    return c;
  },

  async createCategory(data: { name: string; color?: string }): Promise<VideoCategory> {
    const [c] = await db.insert(videoCategories).values(data as any).returning();
    return c;
  },

  async updateCategory(id: string, data: { name?: string; color?: string }): Promise<VideoCategory | undefined> {
    const [c] = await db.update(videoCategories).set(data).where(eq(videoCategories.id, id)).returning();
    return c;
  },

  async deleteCategory(id: string): Promise<void> {
    await db.delete(videoCategories).where(eq(videoCategories.id, id));
  },

  // ── Integration API Keys ─────────────────────────────────────────────────
  async createIntegrationApiKey(clientId: string, label: string): Promise<{ key: IntegrationApiKey; rawKey: string }> {
    const crypto = await import("crypto");
    const raw = `syan_ak_${crypto.randomBytes(32).toString("hex")}`;
    const prefix = raw.slice(0, 16);
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const [key] = await db.insert(integrationApiKeys).values({
      integrationClientId: clientId,
      label,
      apiKeyPrefix: prefix,
      apiKeyHash: hash,
      status: "active",
    } as any).returning();
    return { key, rawKey: raw };
  },

  async getIntegrationApiKeysByClient(clientId: string): Promise<IntegrationApiKey[]> {
    return db.select().from(integrationApiKeys)
      .where(eq(integrationApiKeys.integrationClientId, clientId))
      .orderBy(desc(integrationApiKeys.createdAt));
  },

  async verifyIntegrationApiKey(rawKey: string): Promise<{ key: IntegrationApiKey; client: IntegrationClient } | null> {
    if (!rawKey || !rawKey.startsWith("syan_ak_")) return null;
    const crypto = await import("crypto");
    const hash = crypto.createHash("sha256").update(rawKey).digest("hex");
    const prefix = rawKey.slice(0, 16);
    const [key] = await db.select().from(integrationApiKeys)
      .where(and(eq(integrationApiKeys.apiKeyPrefix, prefix), eq(integrationApiKeys.status, "active")));
    if (!key) return null;
    const valid = crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(key.apiKeyHash, "hex"));
    if (!valid) return null;
    const [client] = await db.select().from(integrationClients)
      .where(eq(integrationClients.id, key.integrationClientId));
    if (!client) return null;
    await db.update(integrationApiKeys).set({ lastUsedAt: new Date() })
      .where(eq(integrationApiKeys.id, key.id));
    return { key, client };
  },

  async revokeIntegrationApiKey(id: string): Promise<void> {
    await db.update(integrationApiKeys).set({ status: "revoked" })
      .where(eq(integrationApiKeys.id, id));
  },
};
