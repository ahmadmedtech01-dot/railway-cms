import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";
import { and, eq, ne } from "drizzle-orm";
import { db } from "./db.js";
import { storageConnections } from "./schema.js";

export type StorageProvider = "backblaze_b2" | "aws_s3" | "cloudflare_r2" | "bunny_net";

export interface NormalizedStorageConfig {
  bucket: string;
  endpoint?: string;
  rawPrefix: string;
  hlsPrefix: string;
}

export interface CreateConnectionInput {
  provider: StorageProvider;
  name: string;
  config: NormalizedStorageConfig;
}

function toNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePrefix(value: unknown, fallback: string): string {
  const base = toNonEmptyString(value) || fallback;
  return base.endsWith("/") ? base : `${base}/`;
}

export function parseCreateConnectionPayload(body: unknown): CreateConnectionInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be an object");
  }

  const input = body as Record<string, unknown>;
  const provider = toNonEmptyString(input.provider) as StorageProvider;
  if (provider !== "backblaze_b2" && provider !== "aws_s3" && provider !== "cloudflare_r2" && provider !== "bunny_net") {
    throw new Error("provider must be backblaze_b2, aws_s3, cloudflare_r2, or bunny_net");
  }

  const name = toNonEmptyString(input.name);
  if (!name) {
    throw new Error("name is required");
  }

  const cfgInput =
    input.config && typeof input.config === "object" && !Array.isArray(input.config)
      ? (input.config as Record<string, unknown>)
      : input;

  const rawPrefix = normalizePrefix(cfgInput.rawPrefix, "raw/");
  const hlsPrefix = normalizePrefix(cfgInput.hlsPrefix, "hls/");

  // Bunny.net has a different config shape (storageZoneName + pullZoneUrl instead of bucket + endpoint)
  if (provider === "bunny_net") {
    const storageZoneName = toNonEmptyString(cfgInput.storageZoneName);
    if (!storageZoneName) throw new Error("storageZoneName is required for bunny_net");
    const pullZoneUrl = toNonEmptyString(cfgInput.pullZoneUrl);
    if (!pullZoneUrl) throw new Error("pullZoneUrl is required for bunny_net");
    const storageRegion = toNonEmptyString(cfgInput.storageRegion) || "de";
    return {
      provider,
      name,
      config: { storageZoneName, pullZoneUrl, rawPrefix, hlsPrefix, storageRegion } as any,
    };
  }

  const bucket = toNonEmptyString(cfgInput.bucket);
  const endpoint = toNonEmptyString(cfgInput.endpoint);

  if (!bucket) {
    throw new Error("bucket is required");
  }

  if (provider === "backblaze_b2" && !endpoint) {
    throw new Error("endpoint is required for backblaze_b2");
  }

  if (provider === "cloudflare_r2" && !endpoint && !process.env.R2_ENDPOINT) {
    throw new Error("endpoint is required for cloudflare_r2 (or set R2_ENDPOINT env var)");
  }

  const effectiveEndpoint = endpoint || (provider === "cloudflare_r2" ? (process.env.R2_ENDPOINT || "") : undefined);

  return {
    provider,
    name,
    config: {
      bucket,
      endpoint: effectiveEndpoint || undefined,
      rawPrefix,
      hlsPrefix,
    },
  };
}

export async function listStorageConnections() {
  return db.select().from(storageConnections);
}

export async function createStorageConnection(input: CreateConnectionInput) {
  const [created] = await db
    .insert(storageConnections)
    .values({
      name: input.name,
      provider: input.provider,
      config: input.config,
      isActive: false,
    })
    .returning();

  return created;
}

export async function deleteStorageConnection(id: string) {
  const [deleted] = await db.delete(storageConnections).where(eq(storageConnections.id, id)).returning();
  return deleted;
}

export async function getStorageConnectionById(id: string) {
  const [conn] = await db.select().from(storageConnections).where(eq(storageConnections.id, id)).limit(1);
  return conn;
}

export async function setActiveStorageConnection(id: string) {
  await db.update(storageConnections).set({ isActive: false }).where(ne(storageConnections.id, id));
  const [updated] = await db
    .update(storageConnections)
    .set({ isActive: true })
    .where(and(eq(storageConnections.id, id)))
    .returning();
  return updated;
}

export async function testStorageConnection(conn: {
  provider: string;
  config: unknown;
}) {
  const cfg = (conn.config || {}) as Record<string, unknown>;
  const bucket = toNonEmptyString(cfg.bucket);

  if (conn.provider === "backblaze_b2") {
    const endpoint = toNonEmptyString(cfg.endpoint);
    if (!endpoint || !bucket) {
      return { ok: false, error: "Connection must include endpoint and bucket" };
    }
    const keyId = process.env.B2_KEY_ID;
    const applicationKey = process.env.B2_APPLICATION_KEY;
    if (!keyId || !applicationKey) {
      return { ok: false, error: "B2_KEY_ID and B2_APPLICATION_KEY are required in environment" };
    }
    try {
      const client = new S3Client({
        region: "us-east-1",
        endpoint,
        forcePathStyle: true,
        credentials: { accessKeyId: keyId, secretAccessKey: applicationKey },
      });
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return { ok: true, message: "Connection successful" };
    } catch (error: any) {
      console.error("STORAGE_CONNECTION_TEST_ERROR", error);
      return { ok: false, error: String(error?.message || error) };
    }
  }

  if (conn.provider === "cloudflare_r2") {
    const endpoint = toNonEmptyString(cfg.endpoint) || process.env.R2_ENDPOINT || "";
    if (!endpoint || !bucket) {
      return { ok: false, error: "Connection must include endpoint and bucket" };
    }
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) {
      return { ok: false, error: "R2_ACCESS_KEY_ID or R2_SECRET_ACCESS_KEY is missing from server environment" };
    }
    try {
      const client = new S3Client({
        region: process.env.R2_REGION || "auto",
        endpoint,
        forcePathStyle: true,
        credentials: { accessKeyId, secretAccessKey },
      });
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return { ok: true, message: "Connection successful" };
    } catch (error: any) {
      console.error("STORAGE_CONNECTION_TEST_ERROR", error);
      return { ok: false, error: String(error?.message || error) };
    }
  }

  if (conn.provider === "aws_s3") {
    if (!bucket) {
      return { ok: false, error: "Connection must include bucket" };
    }
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const region = process.env.AWS_REGION || "us-east-1";
    if (!accessKeyId || !secretAccessKey) {
      return { ok: false, error: "AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY is missing from server environment" };
    }
    try {
      const client = new S3Client({
        region,
        credentials: { accessKeyId, secretAccessKey },
      });
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return { ok: true, message: "Connection successful" };
    } catch (error: any) {
      console.error("STORAGE_CONNECTION_TEST_ERROR", error);
      return { ok: false, error: String(error?.message || error) };
    }
  }

  if (conn.provider === "bunny_net") {
    const storageZoneName = toNonEmptyString(cfg.storageZoneName);
    if (!storageZoneName) return { ok: false, error: "storageZoneName is required" };
    const apiKey = process.env.BUNNY_API_KEY;
    if (!apiKey) return { ok: false, error: "BUNNY_API_KEY is missing from server environment" };
    try {
      const region: string = toNonEmptyString(cfg.storageRegion) || "de";
      const baseUrl = region === "de" || !region ? "https://storage.bunnycdn.com" : `https://${region}.storage.bunnycdn.com`;
      const res = await fetch(`${baseUrl}/${storageZoneName}/`, {
        headers: { AccessKey: apiKey },
      });
      // 200 = zone exists and is accessible; 404 from Bunny = zone exists but is empty
      if (res.status === 200 || res.status === 404) {
        return { ok: true, message: `Bunny storage zone reachable (HTTP ${res.status})` };
      }
      const text = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${text}` };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  return { ok: false, error: `Unsupported provider: ${conn.provider}` };
}
