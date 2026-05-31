import crypto from "crypto";

export interface BunnyConfig {
  storageZoneName: string;
  pullZoneUrl: string;    // e.g. "https://my-zone.b-cdn.net"
  rawPrefix?: string;
  hlsPrefix?: string;
  storageRegion?: string; // "de"|"uk"|"ny"|"la"|"sg"|"syd"|"br"|"se"
}

export function getBunnyStorageKey(): string {
  const key = (process.env.BUNNY_STORAGE_ACCESS_KEY || "").trim();
  if (!key) throw new Error("BUNNY_STORAGE_ACCESS_KEY not set in environment");
  return key;
}

function getStorageHost(region?: string): string {
  if (!region || region === "de" || region === "") return "storage.bunnycdn.com";
  return `${region}.storage.bunnycdn.com`;
}

function buildStorageUrl(storageZoneName: string, remotePath: string, region?: string): string {
  const host = getStorageHost(region);
  const path = remotePath.replace(/^\//, "");
  return `https://${host}/${storageZoneName}/${path}`;
}

function safeDebugLog(label: string, storageZone: string, url: string, key: string): void {
  const keyLen = key.length;
  const keyFirst4 = key.substring(0, 4);
  const keyLast4 = key.substring(key.length - 4);
  const host = new URL(url).hostname;
  console.debug(`[bunny:${label}] storageHost=${host} storageZone=${storageZone} url=${url} keyLength=${keyLen} keyFirst4=${keyFirst4} keyLast4=${keyLast4}`);
}

export async function bunnyUploadFile(
  storageZoneName: string,
  remotePath: string,
  body: Buffer | Uint8Array,
  contentType: string,
  region?: string,
): Promise<void> {
  const accessKey = getBunnyStorageKey();
  const url = buildStorageUrl(storageZoneName, remotePath, region);
  safeDebugLog("upload", storageZoneName, url, accessKey);
  const res = await fetch(url, {
    method: "PUT",
    headers: { AccessKey: accessKey, "Content-Type": contentType },
    body: body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Bunny upload failed (${res.status}): ${text}`);
  }
}

export async function bunnyDeleteFile(
  storageZoneName: string,
  remotePath: string,
  region?: string,
): Promise<void> {
  const accessKey = getBunnyStorageKey();
  const url = buildStorageUrl(storageZoneName, remotePath, region);
  await fetch(url, { method: "DELETE", headers: { AccessKey: accessKey } });
}

async function bunnyListAll(
  storageZoneName: string,
  prefix: string,
  accessKey: string,
  region?: string,
): Promise<string[]> {
  const normalized = prefix.replace(/^\//, "").replace(/\/?$/, "/");
  const url = buildStorageUrl(storageZoneName, normalized, region);
  const res = await fetch(url, { headers: { AccessKey: accessKey } });
  if (!res.ok) return [];
  const items: any[] = await res.json().catch(() => []);
  const keys: string[] = [];
  for (const item of items) {
    const itemPath = `${normalized}${item.ObjectName}`;
    if (item.IsDirectory) {
      const sub = await bunnyListAll(storageZoneName, itemPath, accessKey, region);
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
  const accessKey = getBunnyStorageKey();
  const keys = await bunnyListAll(storageZoneName, prefix, accessKey, region);
  let deleted = 0;
  for (const key of keys) {
    try { await bunnyDeleteFile(storageZoneName, key, region); deleted++; } catch {}
  }
  return deleted;
}

export async function bunnyFetchFile(
  storageZoneName: string,
  remotePath: string,
  region?: string,
): Promise<Buffer> {
  const accessKey = getBunnyStorageKey();
  const url = buildStorageUrl(storageZoneName, remotePath, region);
  const res = await fetch(url, { headers: { AccessKey: accessKey } });
  if (!res.ok) throw new Error(`Bunny fetch failed (${res.status}) key=${remotePath}`);
  return Buffer.from(await res.arrayBuffer());
}

// Generate a CDN URL — signed if BUNNY_TOKEN_AUTH_KEY env var is set, public otherwise.
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
    const accessKey = getBunnyStorageKey();
    const url = buildStorageUrl(storageZoneName, "", region) + "/";
    safeDebugLog("test", storageZoneName, url, accessKey);
    const res = await fetch(url, { headers: { AccessKey: accessKey } });
    if (res.status === 200 || res.status === 404) {
      return { ok: true, message: `Bunny.net connection working — zone "${storageZoneName}" reachable (HTTP ${res.status})` };
    }
    const text = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status}: ${text}` };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
