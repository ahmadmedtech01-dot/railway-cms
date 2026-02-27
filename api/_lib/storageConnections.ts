import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";
import { and, eq, ne } from "drizzle-orm";
import { db } from "./db.js";
import { storageConnections } from "./schema.js";

export type StorageProvider = "backblaze_b2" | "aws_s3";

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
  if (provider !== "backblaze_b2" && provider !== "aws_s3") {
    throw new Error("provider must be backblaze_b2 or aws_s3");
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

  return {
    provider,
    name,
    config: {
      bucket,
      endpoint: endpoint || undefined,
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

export async function testStorageConnectionB2(conn: {
  provider: string;
  config: unknown;
}) {
  if (conn.provider !== "backblaze_b2") {
    return { ok: false, error: "Only backblaze_b2 test is currently supported" };
  }

  const cfg = (conn.config || {}) as Record<string, unknown>;
  const endpoint = toNonEmptyString(cfg.endpoint);
  const bucket = toNonEmptyString(cfg.bucket);

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
      credentials: {
        accessKeyId: keyId,
        secretAccessKey: applicationKey,
      },
    });

    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return { ok: true };
  } catch (error: any) {
    console.error("STORAGE_CONNECTION_TEST_ERROR", error);
    return { ok: false, error: String(error?.message || error) };
  }
}
