import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "../storage";
import { createIntegrationClient, rotateClientSecret } from "./service";
import type { IntegrationClientConfig } from "./types";

function requireAuth(req: any, res: any, next: any) {
  if (!req.session?.adminId) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
}

function log(msg: string) {
  console.log(`[integration-admin] ${msg}`);
}

export function registerIntegrationAdminRoutes(app: Express) {
  // ── LIST CLIENTS ─────────────────────────────────────────────────────────
  app.get("/api/admin/integrations/clients", requireAuth, async (req: Request, res: Response) => {
    try {
      const clients = await storage.getIntegrationClients();
      return res.json(clients);
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET CLIENT ───────────────────────────────────────────────────────────
  app.get("/api/admin/integrations/clients/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const client = await storage.getIntegrationClientById(req.params.id);
      if (!client) return res.status(404).json({ message: "Not found" });

      const videoAccess = await storage.getClientVideoAccess(client.id);
      return res.json({ ...client, videoAccess });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── CREATE CLIENT ────────────────────────────────────────────────────────
  app.post("/api/admin/integrations/clients", requireAuth, async (req: any, res: Response) => {
    try {
      const { name, slug, description, authMode, allowedOrigins, allowedLmsBackendIps, allowedVideoIdsMode, config, videoIds } = req.body;

      if (!name || !slug) {
        return res.status(400).json({ message: "name and slug are required" });
      }

      const existing = await storage.getIntegrationClientBySlug(slug);
      if (existing) {
        return res.status(409).json({ message: "Slug already exists" });
      }

      const { client, rawSecret } = await createIntegrationClient({
        name,
        slug,
        description,
        authMode,
        allowedOrigins: allowedOrigins || [],
        allowedLmsBackendIps: allowedLmsBackendIps || [],
        allowedVideoIdsMode: allowedVideoIdsMode || "all",
        config: config || {},
        adminId: req.session?.adminId,
      });

      if (allowedVideoIdsMode === "selected" && Array.isArray(videoIds)) {
        await storage.setClientVideoAccess(client.id, videoIds);
      }

      await storage.createAuditLog({
        action: "integration_client_created",
        meta: { clientId: client.id, slug, name },
        ip: req.ip,
      });

      log(`CLIENT_CREATED: id=${client.id} slug=${slug}`);
      return res.json({ client, rawSecret });
    } catch (e: any) {
      log(`CREATE_ERROR: ${e.message}`);
      return res.status(500).json({ message: e.message });
    }
  });

  // ── UPDATE CLIENT ────────────────────────────────────────────────────────
  app.patch("/api/admin/integrations/clients/:id", requireAuth, async (req: any, res: Response) => {
    try {
      const { name, description, status, allowedOrigins, allowedLmsBackendIps, allowedVideoIdsMode, config, videoIds } = req.body;

      const updates: any = {};
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (status !== undefined) updates.status = status;
      if (allowedOrigins !== undefined) updates.allowedOrigins = allowedOrigins;
      if (allowedLmsBackendIps !== undefined) updates.allowedLmsBackendIps = allowedLmsBackendIps;
      if (allowedVideoIdsMode !== undefined) updates.allowedVideoIdsMode = allowedVideoIdsMode;
      if (config !== undefined) updates.config = config;

      const client = await storage.updateIntegrationClient(req.params.id, updates);
      if (!client) return res.status(404).json({ message: "Not found" });

      if (allowedVideoIdsMode === "selected" && Array.isArray(videoIds)) {
        await storage.setClientVideoAccess(client.id, videoIds);
      }

      await storage.createAuditLog({
        action: "integration_client_updated",
        meta: { clientId: client.id, updates: Object.keys(updates) },
        ip: req.ip,
      });

      return res.json(client);
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── ROTATE SECRET ────────────────────────────────────────────────────────
  app.post("/api/admin/integrations/clients/:id/rotate-secret", requireAuth, async (req: any, res: Response) => {
    try {
      const result = await rotateClientSecret(req.params.id);
      if (!result) return res.status(404).json({ message: "Not found" });

      await storage.createAuditLog({
        action: "integration_client_secret_rotated",
        meta: { clientId: req.params.id },
        ip: req.ip,
      });

      log(`SECRET_ROTATED: clientId=${req.params.id}`);
      return res.json({ rawSecret: result.rawSecret });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── DELETE CLIENT ────────────────────────────────────────────────────────
  app.delete("/api/admin/integrations/clients/:id", requireAuth, async (req: any, res: Response) => {
    try {
      await storage.deleteIntegrationClient(req.params.id);

      await storage.createAuditLog({
        action: "integration_client_deleted",
        meta: { clientId: req.params.id },
        ip: req.ip,
      });

      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── LAUNCH LOGS ──────────────────────────────────────────────────────────
  app.get("/api/admin/integrations/logs", requireAuth, async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;
      const filters = {
        clientId: req.query.clientId as string,
        status: req.query.status as string,
        publicId: req.query.publicId as string,
        lmsUserId: req.query.lmsUserId as string,
      };

      const result = await storage.getLaunchLogs(limit, offset, filters);
      return res.json(result);
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── PLAYBACK SESSIONS ───────────────────────────────────────────────────
  app.get("/api/admin/integrations/sessions", requireAuth, async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;
      const filters = {
        clientId: req.query.clientId as string,
        status: req.query.status as string,
        publicId: req.query.publicId as string,
        lmsUserId: req.query.lmsUserId as string,
      };

      const result = await storage.getIntegrationPlaybackSessions(limit, offset, filters);
      return res.json(result);
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── REVOKE SESSION ───────────────────────────────────────────────────────
  app.post("/api/admin/integrations/sessions/:id/revoke", requireAuth, async (req: any, res: Response) => {
    try {
      const session = await storage.updateIntegrationPlaybackSession(req.params.id, {
        status: "revoked",
        endedAt: new Date(),
      } as any);

      if (!session) return res.status(404).json({ message: "Session not found" });

      await storage.createAuditLog({
        action: "integration_session_revoked",
        meta: { sessionId: req.params.id },
        ip: req.ip,
      });

      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── SESSION EVENTS ───────────────────────────────────────────────────────
  app.get("/api/admin/integrations/sessions/:id/events", requireAuth, async (req: Request, res: Response) => {
    try {
      const events = await storage.getIntegrationEvents(req.params.id);
      return res.json(events);
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── TEST TOKEN GENERATOR ─────────────────────────────────────────────────
  app.post("/api/admin/integrations/test-token", requireAuth, async (req: any, res: Response) => {
    try {
      const { clientId, publicId, userId, courseId, lessonId } = req.body;

      if (!clientId || !publicId || !userId) {
        return res.status(400).json({ message: "clientId, publicId, userId required" });
      }

      const client = await storage.getIntegrationClientById(clientId);
      if (!client) return res.status(404).json({ message: "Client not found" });

      const masterSecret = process.env.INTEGRATION_MASTER_SECRET;
      if (!masterSecret) return res.status(500).json({ message: "INTEGRATION_MASTER_SECRET not configured" });

      const crypto = await import("crypto");
      const nowSec = Math.floor(Date.now() / 1000);
      const payload: Record<string, any> = {
        iss: client.clientKey,
        aud: "cms-player",
        sub: userId,
        publicId,
        exp: nowSec + 540,
        iat: nowSec,
        jti: crypto.randomUUID(),
      };
      if (courseId) payload.courseId = courseId;
      if (lessonId) payload.lessonId = lessonId;

      const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const sig = crypto.createHmac("sha256", masterSecret).update(payloadB64).digest("hex");
      const token = `${payloadB64}.${sig}`;

      return res.json({ token, payload, expiresIn: 540 });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });
}
