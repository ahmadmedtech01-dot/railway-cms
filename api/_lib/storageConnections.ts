import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";
import { and, eq, ne } from "drizzle-orm";
import { db } from "./db.js";
import { storageConnections } from "./schema.js";

export type StorageProvider = "backblaze_b2" | "aws_s3" | "cloudflare_r2";

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
  if (provider !== "backblaze_b2" && provider !== "aws_s3" && provider !== "cloudflare_r2") {
    throw new Error("provider must be backblaze_b2, aws_s3, or cloudflare_r2");
  }

  const name = toNonEmptyString(input.name);
  if (!name) {
    throw new Error("name is required");
  }

  const cfgInput =
    input.config && typeof input.config === "object" && !Array.isArray(input.config)
      ? (input.config as Record<string, unknown>)
      : input;

  const bucket = toNonEmptyString(cfgInput.bucket);
  const endpoint = toNonEmptyString(cfgInput.endpoint);
  const rawPrefix = normalizePrefix(cfgInput.rawPrefix, "raw/");
  const hlsPrefix = normalizePrefix(cfgInput.hlsPrefix, "hls/");

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

  return { ok: false, error: `Unsupported provider: ${conn.provider}` };
}
