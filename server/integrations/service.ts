import { storage } from "../storage";
import { generateClientKey, generateClientSecret, hashSecret, verifySecret } from "./crypto";
import type { IntegrationClientConfig } from "./types";
import type { IntegrationClient } from "@shared/schema";

export async function createIntegrationClient(data: {
  name: string;
  slug: string;
  description?: string;
  authMode?: string;
  allowedOrigins?: string[];
  allowedLmsBackendIps?: string[];
  allowedVideoIdsMode?: string;
  config?: IntegrationClientConfig;
  adminId?: string;
}): Promise<{ client: IntegrationClient; rawSecret: string }> {
  const clientKey = generateClientKey();
  const rawSecret = generateClientSecret();
  const secretHash = hashSecret(rawSecret);

  const client = await storage.createIntegrationClient({
    name: data.name,
    slug: data.slug,
    description: data.description || null,
    authMode: data.authMode || "hmac",
    clientKey,
    secretHash,
    allowedOrigins: data.allowedOrigins || [],
    allowedLmsBackendIps: data.allowedLmsBackendIps || [],
    allowedVideoIdsMode: data.allowedVideoIdsMode || "all",
    config: data.config || {},
    createdByAdminId: data.adminId || null,
    status: "active",
  } as any);

  return { client, rawSecret };
}

export async function rotateClientSecret(clientId: string): Promise<{ rawSecret: string } | null> {
  const client = await storage.getIntegrationClientById(clientId);
  if (!client) return null;

  const rawSecret = generateClientSecret();
  const secretHash = hashSecret(rawSecret);

  await storage.updateIntegrationClient(clientId, { secretHash } as any);
  return { rawSecret };
}

export async function resolveClientFromIssuer(issuer: string): Promise<IntegrationClient | undefined> {
  let client = await storage.getIntegrationClientByKey(issuer);
  if (!client) {
    client = await storage.getIntegrationClientBySlug(issuer);
  }
  return client;
}

export async function verifyClientSecret(client: IntegrationClient, rawSecret: string): Promise<boolean> {
  return verifySecret(rawSecret, client.secretHash);
}
