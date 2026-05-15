import crypto from "crypto";
import fs from "fs";

export interface BunnyConfig {
  storageZoneName: string;
  pullZoneUrl: string;    // e.g. "https://my-zone.b-cdn.net"
  rawPrefix?: string;
  hlsPrefix?: string;
  storageRegion?: string; // "de"|"uk"|"ny"|"la"|"sg"|"syd"|"br"|"se"
}

export function getBunnyApiKey(): string {
  const key = (process.env.BUNNY_API_KEY || "").trim();
  if (!key) throw new Error("BUNNY_API_KEY not set in environment");
  return key;
}

function getStorageBaseUrl(region?: string): string {
  if (!region || region === "de" || region === "") return "https://storage.bunnycdn.com";
  return `https://${region}.storage.bunnycdn.com`;
}

export async function bunnyUploadFile(
  storageZoneName: string,
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
  region?: string,
): Promise<void> {
  const apiKey = getBunnyApiKey();
  const baseUrl = getStorageBaseUrl(region);
  const url = `${baseUrl}/${storageZoneName}/${key.replace(/^\//, "")}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { AccessKey: apiKey, "Content-Type": contentType },
    body: body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Bunny upload failed (${res.status}): ${text}`);
  }
}

export async function bunnyDeleteFile(
  storageZoneName: string,
  key: string,
  region?: string,
): Promise<void> {
  const apiKey = getBunnyApiKey();
  const baseUrl = getStorageBaseUrl(region);
  const url = `${baseUrl}/${storageZoneName}/${key.replace(/^\//, "")}`;
  await fetch(url, { method: "DELETE", headers: { AccessKey: apiKey } });
}

async function bunnyListAll(
  storageZoneName: string,
  prefix: string,
  apiKey: string,
  region?: string,
): Promise<string[]> {
  const baseUrl = getStorageBaseUrl(region);
  const normalized = prefix.replace(/^\//, "").replace(/\/?$/, "/");
  const url = `${baseUrl}/${storageZoneName}/${normalized}`;
  const res = await fetch(url, { headers: { AccessKey: apiKey } });
  if (!res.ok) return [];
  const items: any[] = await res.json().catch(() => []);
  const keys: string[] = [];
  for (const item of items) {
    const itemPath = `${normalized}${item.ObjectName}`;
    if (item.IsDirectory) {
      const sub = await bunnyListAll(storageZoneName, itemPath, apiKey, region);
      keys.push(...sub);
    } else {
      keys.push(itemPath);
    }
  }
  return keys;
}

export async function bunnyDeletePrefix(
  storageZoneName: string,
  prefix: string,
  region?: string,
): Promise<number> {
  const apiKey = getBunnyApiKey();
  const keys = await bunnyListAll(storageZoneName, prefix, apiKey, region);
  let deleted = 0;
  for (const key of keys) {
    try { await bunnyDeleteFile(storageZoneName, key, region); deleted++; } catch {}
  }
  return deleted;
}

export async function bunnyFetchFile(
  storageZoneName: string,
  key: string,
  region?: string,
): Promise<Buffer> {
  const apiKey = getBunnyApiKey();
  const baseUrl = getStorageBaseUrl(region);
  const url = `${baseUrl}/${storageZoneName}/${key.replace(/^\//, "")}`;
  const res = await fetch(url, { headers: { AccessKey: apiKey } });
  if (!res.ok) throw new Error(`Bunny fetch failed (${res.status}) key=${key}`);
  return Buffer.from(await res.arrayBuffer());
}

// Generate a CDN URL — signed if BUNNY_TOKEN_AUTH_KEY env var is set, public otherwise.
// These URLs are only ever fetched server-side (never sent to the browser).
export function bunnyCdnUrl(
  pullZoneUrl: string,
  key: string,
  ttlSeconds = 60,
): string {
  const tokenAuthKey = (process.env.BUNNY_TOKEN_AUTH_KEY || "").trim() || undefined;
  const base = pullZoneUrl.replace(/\/$/, "");
  const filePath = "/" + key.replace(/^\//, "");
  if (!tokenAuthKey) return `${base}${filePath}`;

  // Bunny CDN Token Authentication
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const hashable = tokenAuthKey + filePath + String(expiry);
  const sha256 = crypto.createHash("sha256").update(hashable).digest("base64");
  const token = sha256.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return `${base}${filePath}?token=${token}&expires=${expiry}`;
}

export async function bunnyTestConnection(
  storageZoneName: string,
  region?: string,
): Promise<{ ok: boolean; message?: string; error?: string }> {
  try {
    const apiKey = getBunnyApiKey();
    const baseUrl = getStorageBaseUrl(region);
    const url = `${baseUrl}/${storageZoneName}/`;
    const res = await fetch(url, { headers: { AccessKey: apiKey } });
    if (res.status === 200 || res.status === 404) {
      return { ok: true, message: `Storage zone reachable (HTTP ${res.status})` };
    }
    const text = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status}: ${text}` };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
