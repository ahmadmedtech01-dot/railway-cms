import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface B2Config {
  endpoint?: string;
  bucket?: string;
  rawPrefix?: string;
  hlsPrefix?: string;
}

export function makeB2Client(config: B2Config = {}): S3Client {
  const endpoint = config.endpoint || process.env.B2_S3_ENDPOINT || "";
  if (!endpoint) throw new Error("B2_S3_ENDPOINT not configured");
  const accessKeyId = (process.env.B2_KEY_ID || "").trim();
  const secretAccessKey = (process.env.B2_APPLICATION_KEY || "").trim();
  if (!accessKeyId || !secretAccessKey) throw new Error("B2_KEY_ID or B2_APPLICATION_KEY not set in environment");
  return new S3Client({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
}

export interface R2Config {
  endpoint?: string;
  bucket?: string;
  rawPrefix?: string;
  hlsPrefix?: string;
}

export function makeR2Client(config: R2Config = {}): S3Client {
  const endpoint = config.endpoint || process.env.R2_ENDPOINT || "";
  if (!endpoint) throw new Error("R2_ENDPOINT not configured");
  const accessKeyId = (process.env.R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || "").trim();
  if (!accessKeyId || !secretAccessKey) throw new Error("R2_ACCESS_KEY_ID or R2_SECRET_ACCESS_KEY not set in environment");
  return new S3Client({
    endpoint,
    region: process.env.R2_REGION || "auto",
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
}

export async function b2PresignPutObject(
  bucket: string,
  key: string,
  contentType: string,
  endpoint: string,
  ttl = 300,
): Promise<string> {
  const client = makeB2Client({ endpoint });
  return getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: ttl });
}

export async function b2PresignGetObject(
  bucket: string,
  key: string,
  endpoint: string,
  ttl = 90,
): Promise<string> {
  const client = makeB2Client({ endpoint });
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttl });
}

export async function b2HeadObject(bucket: string, key: string, endpoint: string): Promise<boolean> {
  const client = makeB2Client({ endpoint });
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function b2UploadFile(
  bucket: string,
  key: string,
  body: Buffer | Uint8Array | NodeJS.ReadableStream,
  contentType: string,
  endpoint: string,
): Promise<void> {
  const client = makeB2Client({ endpoint });
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body as any, ContentType: contentType }));
}

export async function r2PresignGetObject(
  bucket: string,
  key: string,
  endpoint: string,
  ttl = 90,
): Promise<string> {
  const client = makeR2Client({ endpoint });
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttl });
}

export async function r2HeadObject(bucket: string, key: string, endpoint: string): Promise<boolean> {
  const client = makeR2Client({ endpoint });
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function r2UploadFile(
  bucket: string,
  key: string,
  body: Buffer | Uint8Array | NodeJS.ReadableStream,
  contentType: string,
  endpoint: string,
): Promise<void> {
  const client = makeR2Client({ endpoint });
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body as any, ContentType: contentType }));
}
