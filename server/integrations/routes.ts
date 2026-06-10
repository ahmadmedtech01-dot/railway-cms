import type { Express, Request, Response } from "express";
import { storage } from "../storage";
import { resolveClientFromIssuer } from "./service";
import { verifyHmacLaunchToken } from "./crypto";
import { validateLaunchPayload } from "./validation";
import { resolvePermissions } from "./permissions";
import type { IntegrationMintRequest, IntegrationClientConfig, ResolvedPermissions } from "./types";
import { createSession, getTokenTTL, buildSignedProxyUrl } from "../video-session";
import jwt from "jsonwebtoken";
import crypto from "crypto";

function getSigningSecret(): string {
  const s = process.env.SIGNING_SECRET;
  if (!s) {
    if (process.env.NODE_ENV === "production") throw new Error("SIGNING_SECRET required");
    return "insecure-dev-only-signing-key";
  }
  return s;
}

function generateToken(payload: object, ttlSeconds: number): string {
  return jwt.sign({ ...payload, jti: crypto.randomUUID() }, getSigningSecret(), { expiresIn: ttlSeconds });
}

function log(msg: string) {
  console.log(`[integrations] ${msg}`);
}

function errorJson(code: string, message: string) {
  return { ok: false, error: { code, message } };
}

const EMBED_TOKEN_TTL = parseInt(process.env.EMBED_TOKEN_TTL_SECONDS || "300", 10);

export function registerIntegrationRoutes(app: Express) {
  // ── MINT ─────────────────────────────────────────────────────────────────
  app.post("/api/integrations/player/:publicId/mint", async (req: Request, res: Response) => {
    try {
      const { publicId } = req.params;
      const body: IntegrationMintRequest = req.body || {};
      const { launchToken, context } = body;

      if (!launchToken) {
        return res.status(400).json(errorJson("VALIDATION_ERROR", "launchToken is required"));
      }

      const parts = launchToken.split(".");
      if (parts.length !== 2) {
        return res.status(400).json(errorJson("INVALID_LAUNCH_TOKEN", "Token format invalid"));
      }

      let payload: Record<string, any>;
      try {
        payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      } catch {
        return res.status(400).json(errorJson("INVALID_LAUNCH_TOKEN", "Token payload not decodable"));
      }

      const issuer = payload.iss;
      if (!issuer) {
        return res.status(400).json(errorJson("VALIDATION_ERROR", "Token missing iss field"));
      }

      const client = await resolveClientFromIssuer(issuer);
      if (!client) {
        await storage.createLaunchLog({
          publicId, lmsUserId: payload.sub, status: "failed",
          failureReason: "INTEGRATION_CLIENT_NOT_FOUND",
          ipAddress: req.ip, userAgent: req.headers["user-agent"],
          requestPayload: payload,
        } as any);
        return res.status(404).json(errorJson("INTEGRATION_CLIENT_NOT_FOUND", "Integration client not found"));
      }

      if (client.status !== "active") {
        await storage.createLaunchLog({
          integrationClientId: client.id, publicId, lmsUserId: payload.sub,
          status: "denied", failureReason: "INTEGRATION_CLIENT_DISABLED",
          ipAddress: req.ip, userAgent: req.headers["user-agent"],
          requestPayload: payload,
        } as any);
        return res.status(403).json(errorJson("INTEGRATION_CLIENT_DISABLED", "Integration client is disabled"));
      }

      const masterSecret = process.env.INTEGRATION_MASTER_SECRET;
      if (!masterSecret) {
        log("INTEGRATION_MASTER_SECRET not configured");
        return res.status(500).json(errorJson("INTERNAL_ERROR", "Server configuration error"));
      }

      const verifyResult = verifyHmacLaunchToken(launchToken, masterSecret);
      if (!verifyResult) {
        await storage.createLaunchLog({
          integrationClientId: client.id, publicId, lmsUserId: payload.sub,
          status: "failed", failureReason: "INVALID_LAUNCH_TOKEN",
          ipAddress: req.ip, userAgent: req.headers["user-agent"],
          requestPayload: payload,
        } as any);
        return res.status(401).json(errorJson("INVALID_LAUNCH_TOKEN", "Token could not be parsed"));
      }

      if (!verifyResult.valid) {
        await storage.createLaunchLog({
          integrationClientId: client.id, publicId, lmsUserId: payload.sub,
          status: "failed", failureReason: "HMAC_MISMATCH",
          ipAddress: req.ip, userAgent: req.headers["user-agent"],
          requestPayload: payload,
        } as any);
        return res.status(401).json(errorJson("INVALID_LAUNCH_TOKEN", "Token signature invalid"));
      }

      const validation = validateLaunchPayload(verifyResult.payload);
      if (!validation.valid) {
        await storage.createLaunchLog({
          integrationClientId: client.id, publicId, lmsUserId: payload.sub,
          status: "failed", failureReason: validation.code,
          ipAddress: req.ip, userAgent: req.headers["user-agent"],
          requestPayload: payload,
        } as any);
        return res.status(400).json(errorJson(validation.code, validation.message));
      }

      const parsed = validation.parsed;

      if (parsed.publicId !== publicId) {
        await storage.createLaunchLog({
          integrationClientId: client.id, publicId, lmsUserId: parsed.sub,
          status: "failed", failureReason: "LAUNCH_TOKEN_VIDEO_MISMATCH",
          ipAddress: req.ip, userAgent: req.headers["user-agent"],
          requestPayload: payload, launchTokenJti: parsed.jti,
        } as any);
        return res.status(403).json(errorJson("LAUNCH_TOKEN_VIDEO_MISMATCH", "Token publicId does not match URL"));
      }

      const clientConfig = (client.config || {}) as IntegrationClientConfig;
      if (clientConfig.strictOriginCheck && client.allowedOrigins) {
        const origins = client.allowedOrigins as string[];
        const reqOrigin = context?.origin || parsed.origin || req.headers.origin || "";
        if (origins.length > 0 && !origins.includes(reqOrigin as string)) {
          await storage.createLaunchLog({
            integrationClientId: client.id, publicId, lmsUserId: parsed.sub,
            status: "denied", failureReason: "ORIGIN_NOT_ALLOWED",
            origin: reqOrigin as string, ipAddress: req.ip, userAgent: req.headers["user-agent"],
            requestPayload: payload, launchTokenJti: parsed.jti,
          } as any);
          return res.status(403).json(errorJson("ORIGIN_NOT_ALLOWED", "Origin not in allowed list"));
        }
      }

      const video = await storage.getVideoByPublicId(publicId);
      if (!video || !video.available) {
        await storage.createLaunchLog({
          integrationClientId: client.id, publicId, lmsUserId: parsed.sub,
          status: "failed", failureReason: "VIDEO_NOT_FOUND",
          ipAddress: req.ip, userAgent: req.headers["user-agent"],
          requestPayload: payload, launchTokenJti: parsed.jti,
        } as any);
        return res.status(404).json(errorJson("VIDEO_NOT_FOUND", "Video not found or unavailable"));
      }

      if (video.status !== "ready") {
        return res.status(400).json(errorJson("VIDEO_NOT_FOUND", "Video is not ready for playback"));
      }

      const allowed = await storage.isVideoAllowedForClient(client.id, video.id, client.allowedVideoIdsMode);
      if (!allowed) {
        await storage.createLaunchLog({
          integrationClientId: client.id, videoId: video.id, publicId,
          lmsUserId: parsed.sub, status: "denied", failureReason: "VIDEO_NOT_ALLOWED",
          ipAddress: req.ip, userAgent: req.headers["user-agent"],
          requestPayload: payload, launchTokenJti: parsed.jti,
        } as any);
        return res.status(403).json(errorJson("VIDEO_NOT_ALLOWED", "Video not allowed for this client"));
      }

      const [playerSettings, securitySettings] = await Promise.all([
        storage.getPlayerSettings(video.id),
        storage.getSecuritySettings(video.id),
      ]);

      const resolvedPerms = resolvePermissions(clientConfig, playerSettings || null, securitySettings || null, parsed);

      const ttlMs = EMBED_TOKEN_TTL * 1000;
      const expiresAt = new Date(Date.now() + ttlMs);
      const userId = `integration:${client.slug}:${parsed.sub}`;

      // Create the launch log first so we have an ID for the playback session.
      const launchLog = await storage.createLaunchLog({
        integrationClientId: client.id,
        videoId: video.id,
        publicId,
        lmsUserId: parsed.sub,
        lmsCourseId: parsed.courseId || context?.courseId || null,
        lmsLessonId: parsed.lessonId || context?.lessonId || null,
        lmsSessionId: parsed.sessionId || context?.sessionId || null,
        studentName: parsed.name || null,
        studentEmail: parsed.email || null,
        launchTokenJti: parsed.jti,
        origin: context?.origin || parsed.origin || null,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
        status: "success",
        requestPayload: payload,
        resolvedPermissions: resolvedPerms,
      } as any);

      const integrationSession = await storage.createIntegrationPlaybackSession({
        integrationClientId: client.id,
        integrationLaunchLogId: launchLog.id,
        videoId: video.id,
        publicId,
        lmsUserId: parsed.sub,
        lmsCourseId: parsed.courseId || context?.courseId || null,
        lmsLessonId: parsed.lessonId || context?.lessonId || null,
        lmsSessionId: parsed.sessionId || context?.sessionId || null,
        studentName: parsed.name || null,
        studentEmail: parsed.email || null,
        status: "active",
        sessionMetadata: { clientKey: client.clientKey, launchJti: parsed.jti, authMode: "lms_integration" },
      } as any);

      // Generate JWT AFTER integration session exists so we can bind them.
      const tokenValue = generateToken(
        {
          videoId: video.id,
          publicId: video.publicId,
          userId,
          integrationClientId: client.id,
          integrationSessionId: integrationSession.id,
        },
        EMBED_TOKEN_TTL
      );

      await storage.createEmbedToken({
        videoId: video.id,
        token: tokenValue,
        label: `integration:${client.slug}:${parsed.sub}:${parsed.jti}:isid:${integrationSession.id}`,
        allowedDomain: null,
        expiresAt,
        revoked: false,
        userId,
      } as any);

      const cmsBase = process.env.CMS_PUBLIC_BASE_URL || "";
      const manifestUrl = `${cmsBase}/api/player/${publicId}/manifest?token=${tokenValue}`;

      log(`MINT_SUCCESS: client=${client.slug} user=${parsed.sub} video=${publicId} sessionId=${integrationSession.id}`);

      return res.json({
        ok: true,
        integrationSessionId: integrationSession.id,
        embedToken: tokenValue,
        expiresIn: EMBED_TOKEN_TTL,
        manifestUrl,
        refreshUrl: `/api/integrations/player/${publicId}/refresh`,
        pingUrl: `/api/integrations/player/${publicId}/ping`,
        eventUrl: `/api/integrations/player/${publicId}/events`,
        metadata: {
          title: video.title,
          durationSeconds: video.duration || null,
          posterUrl: video.thumbnailUrl || null,
          publicId: video.publicId,
        },
        playerConfig: resolvedPerms,
      });
    } catch (e: any) {
      log(`MINT_ERROR: ${e.message}`);
      return res.status(500).json(errorJson("INTERNAL_ERROR", "Internal server error"));
    }
  });

  // ── REFRESH ──────────────────────────────────────────────────────────────
  app.post("/api/integrations/player/:publicId/refresh", async (req: Request, res: Response) => {
    try {
      const { publicId } = req.params;
      const { integrationSessionId } = req.body || {};

      if (!integrationSessionId) {
        return res.status(400).json(errorJson("VALIDATION_ERROR", "integrationSessionId required"));
      }

      const session = await storage.getIntegrationPlaybackSessionById(integrationSessionId);
      if (!session || session.status !== "active") {
        return res.status(404).json(errorJson("INTEGRATION_SESSION_NOT_FOUND", "Integration session not found or expired"));
      }

      if (session.publicId !== publicId) {
        return res.status(403).json(errorJson("FORBIDDEN", "Session does not match video"));
      }

      const video = await storage.getVideoByPublicId(publicId);
      if (!video) {
        return res.status(404).json(errorJson("VIDEO_NOT_FOUND", "Video not found"));
      }

      const expiresAt = new Date(Date.now() + EMBED_TOKEN_TTL * 1000);
      const client = session.integrationClientId ? await storage.getIntegrationClientById(session.integrationClientId) : null;
      const clientSlug = client?.slug || "unknown";
      const userId = `integration:${clientSlug}:${session.lmsUserId}`;

      // Extend the existing token's DB expiry instead of minting a new JWT.
      // Creating a new token on every refresh accumulates active tokens for the
      // same userId. Once count >= concurrentSessionLimit, the next mint attempt
      // gets a 429 SESSION_LIMIT, which can trigger revokeUserTokensExcept() and
      // kill the token the embed player is still holding — causing "Access Link Expired".
      const existingTokens = await storage.getActiveUserTokens(video.id, userId);
      // Prefer a token bound to this specific integration session
      const sessionToken = existingTokens.find(t =>
        (t as any).label?.includes(`:isid:${session.id}`)
      ) ?? existingTokens[0] ?? null;

      let finalTokenValue: string;
      if (sessionToken) {
        await storage.extendEmbedTokenExpiry(sessionToken.token, expiresAt);
        finalTokenValue = sessionToken.token;
        // Revoke any other accumulated tokens for this user so the count stays at 1
        for (const t of existingTokens) {
          if (t.id !== sessionToken.id) {
            await storage.revokeToken(t.id).catch(() => {});
          }
        }
        log(`INTEGRATION_REFRESH_EXTEND: client=${clientSlug} user=${session.lmsUserId} session=${session.id} tokenId=${sessionToken.id} extraRevoked=${existingTokens.length - 1}`);
      } else {
        // No existing token found — mint a fresh one as fallback
        finalTokenValue = generateToken(
          { videoId: video.id, publicId: video.publicId, userId, integrationClientId: session.integrationClientId, integrationSessionId: session.id },
          EMBED_TOKEN_TTL
        );
        await storage.createEmbedToken({
          videoId: video.id,
          token: finalTokenValue,
          label: `integration:refresh:${clientSlug}:${session.lmsUserId}:isid:${session.id}`,
          allowedDomain: null,
          expiresAt,
          revoked: false,
          userId,
        } as any);
        log(`INTEGRATION_REFRESH_MINT: client=${clientSlug} user=${session.lmsUserId} session=${session.id} (no existing token found, minted fresh)`);
      }

      // Reset startedAt so the tokenExpiresIn calculation in /ping
      // reads as a full TTL again after a successful refresh, not 0.
      await storage.updateIntegrationPlaybackSession(integrationSessionId, { lastPingAt: new Date(), startedAt: new Date() } as any);

      const cmsBase = process.env.CMS_PUBLIC_BASE_URL || "";
      const manifestUrl = `${cmsBase}/api/player/${publicId}/manifest?token=${finalTokenValue}`;

      return res.json({
        ok: true,
        embedToken: finalTokenValue,
        expiresIn: EMBED_TOKEN_TTL,
        manifestUrl,
      });
    } catch (e: any) {
      log(`REFRESH_ERROR: ${e.message}`);
      return res.status(500).json(errorJson("INTERNAL_ERROR", "Internal server error"));
    }
  });

  // ── PING ─────────────────────────────────────────────────────────────────
  app.post("/api/integrations/player/:publicId/ping", async (req: Request, res: Response) => {
    try {
      const { integrationSessionId, currentTime, duration, paused, ended } = req.body || {};

      if (!integrationSessionId) {
        return res.status(400).json(errorJson("VALIDATION_ERROR", "integrationSessionId required"));
      }

      const session = await storage.getIntegrationPlaybackSessionById(integrationSessionId);
      if (!session || session.status !== "active") {
        return res.status(404).json(errorJson("INTEGRATION_SESSION_NOT_FOUND", "Session not found"));
      }

      const currentPos = Math.floor(currentTime || 0);
      const pingIntervalSec = 10;
      const watchedIncrement = (!paused && currentPos > session.maxPositionSeconds) ? Math.min(pingIntervalSec, currentPos - session.maxPositionSeconds) : 0;
      const watchedSeconds = session.watchedSeconds + watchedIncrement;
      const maxPos = Math.max(session.maxPositionSeconds, currentPos);
      const completionPercent = duration > 0 ? Math.min(100, Math.round((maxPos / duration) * 100)) : 0;

      const updates: any = {
        lastPingAt: new Date(),
        watchedSeconds,
        maxPositionSeconds: maxPos,
        completionPercent,
      };

      if (ended) {
        updates.status = "ended";
        updates.endedAt = new Date();
      }

      await storage.updateIntegrationPlaybackSession(integrationSessionId, updates);

      // Return actual remaining seconds so the LMS can schedule proactive refresh accurately.
      // session.startedAt marks when the token was issued (same TTL as the embed token).
      const elapsedSec = session.startedAt
        ? Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 1000)
        : 0;
      const tokenExpiresIn = Math.max(0, EMBED_TOKEN_TTL - elapsedSec);
      return res.json({ ok: true, sessionState: ended ? "ended" : "active", tokenExpiresIn });
    } catch (e: any) {
      log(`PING_ERROR: ${e.message}`);
      return res.status(500).json(errorJson("INTERNAL_ERROR", "Internal server error"));
    }
  });

  // ── EVENTS ───────────────────────────────────────────────────────────────
  app.post("/api/integrations/player/:publicId/events", async (req: Request, res: Response) => {
    try {
      const { integrationSessionId, events } = req.body || {};

      if (!integrationSessionId || !Array.isArray(events)) {
        return res.status(400).json(errorJson("VALIDATION_ERROR", "integrationSessionId and events[] required"));
      }

      const session = await storage.getIntegrationPlaybackSessionById(integrationSessionId);
      if (!session) {
        return res.status(404).json(errorJson("INTEGRATION_SESSION_NOT_FOUND", "Session not found"));
      }

      await storage.createIntegrationEvents(
        integrationSessionId,
        events.map((e: any) => ({
          eventType: String(e.type || "unknown"),
          eventTimeSeconds: e.time !== undefined ? String(e.time) : undefined,
          payload: e.payload || {},
        }))
      );

      return res.json({ ok: true, received: events.length });
    } catch (e: any) {
      log(`EVENTS_ERROR: ${e.message}`);
      return res.status(500).json(errorJson("INTERNAL_ERROR", "Internal server error"));
    }
  });

  // ── COMPLETE ─────────────────────────────────────────────────────────────
  app.post("/api/integrations/player/:publicId/complete", async (req: Request, res: Response) => {
    try {
      const { integrationSessionId, completionPercent } = req.body || {};

      if (!integrationSessionId) {
        return res.status(400).json(errorJson("VALIDATION_ERROR", "integrationSessionId required"));
      }

      const session = await storage.getIntegrationPlaybackSessionById(integrationSessionId);
      if (!session) {
        return res.status(404).json(errorJson("INTEGRATION_SESSION_NOT_FOUND", "Session not found"));
      }

      await storage.updateIntegrationPlaybackSession(integrationSessionId, {
        completionPercent: Math.min(100, completionPercent || 100),
        status: "ended",
        endedAt: new Date(),
      } as any);

      return res.json({ ok: true });
    } catch (e: any) {
      log(`COMPLETE_ERROR: ${e.message}`);
      return res.status(500).json(errorJson("INTERNAL_ERROR", "Internal server error"));
    }
  });

  // ── METADATA ─────────────────────────────────────────────────────────────
  app.get("/api/integrations/videos/:publicId", async (req: Request, res: Response) => {
    try {
      const apiKey = (req.headers["x-api-key"] as string || "").trim();
      const authHeader = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
      const token = apiKey || authHeader;

      if (!token) {
        return res.status(401).json(errorJson("FORBIDDEN", "Authentication required"));
      }

      let decoded: any;
      try {
        decoded = jwt.verify(token, getSigningSecret());
      } catch {
        return res.status(401).json(errorJson("EMBED_TOKEN_INVALID", "Invalid token"));
      }

      const video = await storage.getVideoByPublicId(req.params.publicId);
      if (!video || !video.available) {
        return res.status(404).json(errorJson("VIDEO_NOT_FOUND", "Video not found"));
      }

      return res.json({
        ok: true,
        publicId: video.publicId,
        title: video.title,
        description: video.description,
        duration: video.duration,
        posterUrl: video.thumbnailUrl,
      });
    } catch (e: any) {
      return res.status(500).json(errorJson("INTERNAL_ERROR", "Internal server error"));
    }
  });

  // ── CONFIG ───────────────────────────────────────────────────────────────
  app.get("/api/integrations/player/:publicId/config", async (req: Request, res: Response) => {
    try {
      const sessionId = req.query.integrationSessionId as string;
      if (!sessionId) {
        return res.status(400).json(errorJson("VALIDATION_ERROR", "integrationSessionId query param required"));
      }

      const session = await storage.getIntegrationPlaybackSessionById(sessionId);
      if (!session || session.status !== "active") {
        return res.status(404).json(errorJson("INTEGRATION_SESSION_NOT_FOUND", "Session not found"));
      }

      const client = session.integrationClientId ? await storage.getIntegrationClientById(session.integrationClientId) : null;
      const video = session.videoId ? await storage.getVideoByPublicId(session.publicId) : null;
      const [playerSettings, securitySettings] = await Promise.all([
        video ? storage.getPlayerSettings(video.id) : null,
        video ? storage.getSecuritySettings(video.id) : null,
      ]);

      const clientConfig = (client?.config || {}) as IntegrationClientConfig;
      const dummyPayload = { iss: "", aud: "cms-player", sub: session.lmsUserId, publicId: session.publicId, exp: 0, iat: 0, jti: "" };
      const perms = resolvePermissions(clientConfig, playerSettings || null, securitySettings || null, dummyPayload);

      return res.json({ ok: true, playerConfig: perms });
    } catch (e: any) {
      return res.status(500).json(errorJson("INTERNAL_ERROR", "Internal server error"));
    }
  });

  // ── SIMPLE EMBED URL (Gumlet-style, API key auth) ────────────────────────
  // POST /api/integrations/embed-url
  // Header: X-Api-Key: syan_ak_xxx
  // Body:   { videoId, studentId, courseId?, lessonId?, studentName?, studentEmail? }
  // Returns: { iframeUrl, embedToken, integrationSessionId, expiresIn, video }
  app.post("/api/integrations/embed-url", async (req: Request, res: Response) => {
    try {
      const rawKey = (req.headers["x-api-key"] as string || "").trim();
      if (!rawKey) return res.status(401).json(errorJson("UNAUTHORIZED", "X-Api-Key header required"));

      // Phase 1 (parallel): validate API key + fetch video at the same time
      const { videoId, studentId, courseId, lessonId, studentName, studentEmail, startAt } = req.body || {};
      if (!videoId || !studentId) return res.status(400).json(errorJson("VALIDATION_ERROR", "videoId and studentId are required"));

      const [verified, video] = await Promise.all([
        storage.verifyIntegrationApiKey(rawKey),
        storage.getVideoByPublicId(videoId),
      ]);

      if (!verified) return res.status(401).json(errorJson("INVALID_API_KEY", "API key invalid or revoked"));
      const { client } = verified;
      if (client.status !== "active") return res.status(403).json(errorJson("INTEGRATION_CLIENT_DISABLED", "Integration client is disabled"));

      if (!video || !video.available) return res.status(404).json(errorJson("VIDEO_NOT_FOUND", "Video not found or unavailable"));
      if (video.status !== "ready") return res.status(400).json(errorJson("VIDEO_NOT_READY", "Video is not ready for playback"));

      // Phase 2 (parallel): access check + player/security settings + previous session for auto-resume
      const [allowed, playerSettings, securitySettings, prevSession] = await Promise.all([
        storage.isVideoAllowedForClient(client.id, video.id, client.allowedVideoIdsMode),
        storage.getPlayerSettings(video.id),
        storage.getSecuritySettings(video.id),
        // Look up previous session so we can auto-resume even if LMS didn't pass startAt
        storage.getLatestIntegrationPlaybackSessionForUser(videoId, String(studentId), client.id),
      ]);

      if (!allowed) return res.status(403).json(errorJson("VIDEO_NOT_ALLOWED", "Video not allowed for this client"));

      const clientConfig = (client.config || {}) as any;
      const dummyPayload = { iss: client.clientKey, aud: "cms-player", sub: String(studentId), publicId: videoId, exp: 0, iat: 0, jti: "" };
      const resolvedPerms = resolvePermissions(clientConfig, playerSettings || null, securitySettings || null, dummyPayload);

      const ttlMs = EMBED_TOKEN_TTL * 1000;
      const expiresAt = new Date(Date.now() + ttlMs);
      const userId = `integration:${client.slug}:${studentId}`;

      const launchLog = await storage.createLaunchLog({
        integrationClientId: client.id,
        videoId: video.id,
        publicId: videoId,
        lmsUserId: String(studentId),
        lmsCourseId: courseId || null,
        lmsLessonId: lessonId || null,
        studentName: studentName || null,
        studentEmail: studentEmail || null,
        launchTokenJti: `apikey:${verified.key.id}`,
        origin: req.headers.origin || null,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
        status: "success",
        requestPayload: { videoId, studentId, courseId, lessonId, authMode: "api_key" },
        resolvedPermissions: resolvedPerms,
      } as any);

      // ── Session reuse: if there is already an active session for this
      // client+user+video, renew its token instead of creating a brand-new
      // session. This prevents the "restart from 0" problem that happens when
      // the LMS calls embed-url every ~5 min because the token is expiring.
      //
      // Token strategy (IMPORTANT):
      //   old behaviour → new JWT minted each call → multiple active tokens accumulate
      //                   → concurrent-session limit hit → revokeUserTokensExcept()
      //                   → embed player's token killed → "Access Link Expired"
      //   new behaviour → existing DB token expiry extended → same JWT reused
      //                   → token count stays at 1 → no revocation → stable playback
      //
      // We reset startedAt to now so that the tokenExpiresIn calculation in
      // subsequent /ping calls reads as a full TTL again (not 0 immediately).
      const activeSession = prevSession?.status === "active" ? prevSession : null;

      let integrationSession: any;
      let tokenValue: string;

      if (activeSession) {
        await storage.updateIntegrationPlaybackSession(activeSession.id, {
          startedAt: new Date(),
          lastPingAt: new Date(),
        });
        integrationSession = { ...activeSession, startedAt: new Date() };

        // Try to extend the existing token rather than minting a new JWT
        const existingTokens = await storage.getActiveUserTokens(video.id, userId);
        const sessionToken = existingTokens.find(t =>
          (t as any).label?.includes(`:isid:${activeSession.id}`)
        ) ?? existingTokens[0] ?? null;

        if (sessionToken) {
          await storage.extendEmbedTokenExpiry(sessionToken.token, expiresAt);
          tokenValue = sessionToken.token;
          // Revoke any extra accumulated tokens so the per-user count stays at 1
          for (const t of existingTokens) {
            if (t.id !== sessionToken.id) {
              await storage.revokeToken(t.id).catch(() => {});
            }
          }
          log(`SIMPLE_EMBED_RENEW: client=${client.slug} user=${studentId} video=${videoId} session=${activeSession.id} pos=${activeSession.maxPositionSeconds}s tokenExtended=true extraRevoked=${existingTokens.length - 1}`);
        } else {
          // No existing token found — mint a fresh JWT as fallback
          tokenValue = generateToken({
            videoId: video.id, publicId: video.publicId, userId,
            integrationClientId: client.id, integrationSessionId: activeSession.id,
          }, EMBED_TOKEN_TTL);
          storage.createEmbedToken({
            videoId: video.id,
            token: tokenValue,
            label: `integration:apikey:${client.slug}:${studentId}:isid:${activeSession.id}`,
            allowedDomain: null,
            expiresAt,
            revoked: false,
            userId,
          } as any).catch((e: any) => log(`SIMPLE_EMBED_TOKEN_WRITE_ERR: ${e.message}`));
          log(`SIMPLE_EMBED_RENEW: client=${client.slug} user=${studentId} video=${videoId} session=${activeSession.id} pos=${activeSession.maxPositionSeconds}s tokenExtended=false (no existing token)`);
        }
      } else {
        integrationSession = await storage.createIntegrationPlaybackSession({
          integrationClientId: client.id,
          integrationLaunchLogId: launchLog.id,
          videoId: video.id,
          publicId: videoId,
          lmsUserId: String(studentId),
          lmsCourseId: courseId || null,
          lmsLessonId: lessonId || null,
          studentName: studentName || null,
          studentEmail: studentEmail || null,
          status: "active",
          sessionMetadata: { clientKey: client.clientKey, authMode: "api_key", apiKeyPrefix: verified.key.apiKeyPrefix },
        } as any);

        tokenValue = generateToken({
          videoId: video.id,
          publicId: video.publicId,
          userId,
          integrationClientId: client.id,
          integrationSessionId: integrationSession.id,
        }, EMBED_TOKEN_TTL);

        // Fire-and-forget audit write — does not block the caller.
        // Respond immediately: the token is a self-contained signed JWT so the
        // embed player can validate it cryptographically even before the DB row
        // lands. /manifest falls back to jwt.verify() when getTokenByValue()
        // returns null, so the write race is safe.
        storage.createEmbedToken({
          videoId: video.id,
          token: tokenValue,
          label: `integration:apikey:${client.slug}:${studentId}:isid:${integrationSession.id}`,
          allowedDomain: null,
          expiresAt,
          revoked: false,
          userId,
        } as any).catch((e: any) => log(`SIMPLE_EMBED_TOKEN_WRITE_ERR: ${e.message}`));
      }

      const cmsBase = process.env.CMS_PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
      // Explicit startAt wins; if absent, use the session's saved position
      // (set by /tick every 20 s via touchIntegrationSessionPosition, so it
      // reflects where the player actually was even if the LMS ping omits
      // currentTime). The player reads ?t= → pendingInitialSeekRef → seek.
      const sessionForResume = activeSession || prevSession;
      const explicitStartAt = startAt !== undefined && startAt !== null ? Math.max(0, Math.floor(Number(startAt))) : 0;
      const autoResumeAt = explicitStartAt > 0
        ? explicitStartAt
        : (sessionForResume && sessionForResume.maxPositionSeconds > 5 ? Math.floor(sessionForResume.maxPositionSeconds) : 0);
      const iframeUrl = `${cmsBase}/embed/${videoId}?token=${tokenValue}${autoResumeAt > 0 ? `&t=${autoResumeAt}` : ""}`;
      const manifestUrl = `${cmsBase}/api/player/${videoId}/manifest?token=${tokenValue}`;

      log(`SIMPLE_EMBED: client=${client.slug} user=${studentId} video=${videoId} session=${integrationSession.id} resume=${autoResumeAt > 0 ? `${autoResumeAt}s` : "start"}`);

      res.json({
        ok: true,
        iframeUrl,
        embedToken: tokenValue,
        manifestUrl,
        integrationSessionId: integrationSession.id,
        expiresIn: EMBED_TOKEN_TTL,
        pingUrl: `/api/integrations/player/${videoId}/ping`,
        video: {
          title: video.title,
          durationSeconds: video.duration || null,
          posterUrl: video.thumbnailUrl || null,
          publicId: video.publicId,
        },
        playerConfig: resolvedPerms,
      });
    } catch (e: any) {
      log(`SIMPLE_EMBED_ERROR: ${e.message}`);
      return res.status(500).json(errorJson("INTERNAL_ERROR", "Internal server error"));
    }
  });

  // ── EMBED PAGE ───────────────────────────────────────────────────────────
  app.get("/api/integrations/embed/:publicId", async (req: Request, res: Response) => {
    const { publicId } = req.params;
    const launchToken = req.query.launchToken as string || "";
    const token = req.query.token as string || "";

    const cmsBase = process.env.CMS_PUBLIC_BASE_URL || "";

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Video Player</title>
<style>*{margin:0;padding:0;box-sizing:border-box}html,body,#player{width:100%;height:100%;overflow:hidden;background:#000}</style>
</head>
<body>
<div id="player"></div>
<script>
(function(){
  var publicId = ${JSON.stringify(publicId)};
  var launchToken = ${JSON.stringify(launchToken)};
  var embedToken = ${JSON.stringify(token)};
  var cmsBase = ${JSON.stringify(cmsBase)};
  var parentOrigin = document.referrer ? new URL(document.referrer).origin : "*";

  function postToParent(type, data) {
    try { window.parent.postMessage({ type: "syan.player." + type, data: data || {} }, parentOrigin); } catch(e) {}
  }

  async function init() {
    var tokenToUse = embedToken;
    var sessionId = null;
    var manifestUrl = null;

    if (launchToken && !embedToken) {
      try {
        var mintRes = await fetch(cmsBase + "/api/integrations/player/" + publicId + "/mint", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ launchToken: launchToken })
        });
        var mintData = await mintRes.json();
        if (!mintData.ok) { postToParent("error", mintData.error); return; }
        tokenToUse = mintData.embedToken;
        sessionId = mintData.integrationSessionId;
        manifestUrl = mintData.manifestUrl;
      } catch(e) { postToParent("error", { code: "MINT_FAILED", message: e.message }); return; }
    }

    if (!tokenToUse) { postToParent("error", { code: "NO_TOKEN", message: "No token available" }); return; }

    if (!manifestUrl) manifestUrl = cmsBase + "/api/player/" + publicId + "/manifest?token=" + tokenToUse;

    // Redirect to existing embed player with the token
    window.location.replace("/embed/" + publicId + "?token=" + encodeURIComponent(tokenToUse));
  }

  init();
  window.addEventListener("message", function(e) {
    if (!e.data || !e.data.type) return;
    // forward commands from parent
  });
})();
</script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html");
    return res.send(html);
  });
}
