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

      const verifyResult = verifyHmacLaunchToken(launchToken, client.secretHash, masterSecret);
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

      const tokenValue = generateToken(
        { videoId: video.id, publicId: video.publicId, userId, integrationClientId: client.id },
        EMBED_TOKEN_TTL
      );

      const dbToken = await storage.createEmbedToken({
        videoId: video.id,
        token: tokenValue,
        label: `integration:${client.slug}:${parsed.sub}:${parsed.jti}`,
        allowedDomain: null,
        expiresAt,
        revoked: false,
        userId,
      } as any);

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
        sessionMetadata: { clientKey: client.clientKey, launchJti: parsed.jti },
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
      const { integrationSessionId, embedToken } = req.body || {};

      if (!integrationSessionId || !embedToken) {
        return res.status(400).json(errorJson("VALIDATION_ERROR", "integrationSessionId and embedToken required"));
      }

      const session = await storage.getIntegrationPlaybackSessionById(integrationSessionId);
      if (!session || session.status !== "active") {
        return res.status(404).json(errorJson("INTEGRATION_SESSION_NOT_FOUND", "Integration session not found or expired"));
      }

      if (session.publicId !== publicId) {
        return res.status(403).json(errorJson("FORBIDDEN", "Session does not match video"));
      }

      const dbToken = await storage.getTokenByValue(embedToken);
      if (!dbToken) {
        return res.status(401).json(errorJson("EMBED_TOKEN_INVALID", "Embed token not found"));
      }

      const video = await storage.getVideoByPublicId(publicId);
      if (!video) {
        return res.status(404).json(errorJson("VIDEO_NOT_FOUND", "Video not found"));
      }

      await storage.revokeToken(dbToken.id);

      const expiresAt = new Date(Date.now() + EMBED_TOKEN_TTL * 1000);
      const newTokenValue = generateToken(
        { videoId: video.id, publicId: video.publicId, userId: session.lmsUserId, integrationClientId: session.integrationClientId },
        EMBED_TOKEN_TTL
      );

      await storage.createEmbedToken({
        videoId: video.id,
        token: newTokenValue,
        label: `integration:refresh:${session.lmsUserId}`,
        allowedDomain: null,
        expiresAt,
        revoked: false,
        userId: `integration:${session.lmsUserId}`,
      } as any);

      await storage.updateIntegrationPlaybackSession(integrationSessionId, { lastPingAt: new Date() } as any);

      const cmsBase = process.env.CMS_PUBLIC_BASE_URL || "";
      const manifestUrl = `${cmsBase}/api/player/${publicId}/manifest?token=${newTokenValue}`;

      return res.json({
        ok: true,
        embedToken: newTokenValue,
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

      const watchedSeconds = Math.max(session.watchedSeconds, Math.floor(currentTime || 0));
      const maxPos = Math.max(session.maxPositionSeconds, Math.floor(currentTime || 0));
      const completionPercent = duration > 0 ? Math.min(100, Math.round((watchedSeconds / duration) * 100)) : 0;

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

      return res.json({ ok: true, sessionState: ended ? "ended" : "active", tokenExpiresIn: EMBED_TOKEN_TTL });
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
