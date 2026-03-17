import type { VercelRequest, VercelResponse } from "@vercel/node";
import { desc } from "drizzle-orm";
import { db } from "./_lib/db.js";
import { getSessionFromRequest } from "./_lib/auth.js";
import { storageConnections } from "./_lib/schema.js";

type StorageProvider = "backblaze_b2" | "aws_s3" | "cloudflare_r2";

interface StorageConfigInput {
  bucket?: unknown;
  endpoint?: unknown;
  rawPrefix?: unknown;
  hlsPrefix?: unknown;
  keyId?: unknown;
  applicationKey?: unknown;
}

interface ParsedCreatePayload {
  name: string;
  provider: StorageProvider;
  config: {
    bucket: string;
    endpoint: string;
    rawPrefix: string;
    hlsPrefix: string;
    keyId?: string;
    applicationKey?: string;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asOptionalString(value: unknown): string | undefined {
  const parsed = asNonEmptyString(value);
  return parsed || undefined;
}

function normalizePrefix(value: unknown, fallback: string): string {
  const parsed = asNonEmptyString(value) || fallback;
  return parsed.endsWith("/") ? parsed : `${parsed}/`;
}

function parseCreatePayload(body: unknown): ParsedCreatePayload {
  if (!isObject(body)) {
    throw new Error("Request body must be a JSON object");
  }

  const providerRaw = asNonEmptyString(body.provider);
  if (providerRaw !== "backblaze_b2" && providerRaw !== "aws_s3" && providerRaw !== "cloudflare_r2") {
    throw new Error("provider must be one of: backblaze_b2, aws_s3, cloudflare_r2");
  }

  const name = asNonEmptyString(body.name) || asNonEmptyString(body.connectionName);
  if (!name) {
    throw new Error("connectionName (or name) is required");
  }

  const inputConfig: StorageConfigInput = isObject(body.config) ? body.config : body;

  const bucket = asNonEmptyString(inputConfig.bucket ?? body.bucketName);
  const endpoint = asNonEmptyString(inputConfig.endpoint ?? body.endpoint);
  const rawPrefix = normalizePrefix(inputConfig.rawPrefix ?? body.rawPrefix, "raw/");
  const hlsPrefix = normalizePrefix(inputConfig.hlsPrefix ?? body.hlsPrefix, "hls/");

  if (!bucket) {
    throw new Error("bucketName (or config.bucket) is required");
  }

  if (providerRaw === "backblaze_b2" && !endpoint) {
    throw new Error("endpoint is required for backblaze_b2");
  }

  if (providerRaw === "cloudflare_r2" && !endpoint) {
    throw new Error("endpoint is required for cloudflare_r2");
  }

  return {
    name,
    provider: providerRaw,
    config: {
      bucket,
      endpoint,
      rawPrefix,
      hlsPrefix,
      keyId: asOptionalString(inputConfig.keyId ?? body.keyId),
      applicationKey: asOptionalString(inputConfig.applicationKey ?? body.applicationKey),
    },
  };
}

function makeErrorId(): string {
  return `storage_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  const session = getSessionFromRequest(req as any);
  if (!session) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  try {
    if (req.method === "GET") {
      const connections = await db.select().from(storageConnections).orderBy(desc(storageConnections.createdAt));
      return res.status(200).json({ connections });
    }

    const payload = parseCreatePayload(req.body);
    const [connection] = await db
      .insert(storageConnections)
      .values({
        name: payload.name,
        provider: payload.provider,
        config: payload.config,
        isActive: false,
      })
      .returning();

    return res.status(200).json({ success: true, connection });
  } catch (error: any) {
    const message = typeof error?.message === "string" ? error.message : "Unexpected server error";
    const isValidationError = [
      "Request body must be a JSON object",
      "provider must be one of: backblaze_b2, aws_s3, cloudflare_r2",
      "connectionName (or name) is required",
      "bucketName (or config.bucket) is required",
      "endpoint is required for backblaze_b2",
      "endpoint is required for cloudflare_r2",
    ].includes(message);

    if (isValidationError) {
      return res.status(400).json({ success: false, message });
    }

    const errorId = makeErrorId();
    console.error("STORAGE_CONNECTIONS_API_ERROR", errorId, error);
    return res.status(500).json({ success: false, errorId, message: "Failed to process storage connection request" });
  }
}
