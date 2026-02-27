import type { VercelRequest, VercelResponse } from "@vercel/node";
import { eq } from "drizzle-orm";
import { db } from "./_lib/db.js";
import { getSessionFromRequest } from "./_lib/auth.js";
import { systemSettings } from "./_lib/schema.js";

const SECRET_KEYS = [
  "aws_secret_access_key",
  "vimeo_access_token",
  "signing_secret",
  "session_secret",
  "b2_application_key",
  "application_key",
];

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SECRET_KEYS.some((secretKey) => normalized.includes(secretKey));
}

function maskValue(value: string | null): string {
  if (!value) return "";
  return "•".repeat(value.length);
}

function parseUpdates(body: unknown): Record<string, string> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be an object");
  }

  const updates: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(body as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key) continue;
    updates[key] = typeof rawValue === "string" ? rawValue : String(rawValue ?? "");
  }

  if (Object.keys(updates).length === 0) {
    throw new Error("At least one setting key/value is required");
  }

  return updates;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "PUT") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const session = getSessionFromRequest(req as any);
  if (!session) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    if (req.method === "GET") {
      const rows = await db.select().from(systemSettings);
      const masked = rows.map((row) => ({
        key: row.key,
        value: isSecretKey(row.key) ? maskValue(row.value) : row.value || "",
      }));
      return res.status(200).json(masked);
    }

    const updates = parseUpdates(req.body);

    for (const [key, value] of Object.entries(updates)) {
      const [existing] = await db.select().from(systemSettings).where(eq(systemSettings.key, key)).limit(1);
      if (existing) {
        await db.update(systemSettings).set({ value, updatedAt: new Date() }).where(eq(systemSettings.key, key));
      } else {
        await db.insert(systemSettings).values({ key, value });
      }
    }

    return res.status(200).json({ ok: true });
  } catch (error: any) {
    const message = typeof error?.message === "string" ? error.message : "Failed to handle settings";
    const isBadRequest =
      message === "Request body must be an object" || message === "At least one setting key/value is required";

    if (isBadRequest) {
      return res.status(400).json({ ok: false, error: message });
    }

    console.error("SETTINGS_API_ERROR", error);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
}
