import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSessionFromRequest } from "../_lib/auth.js";
import {
  createStorageConnection,
  listStorageConnections,
  parseCreateConnectionPayload,
} from "../_lib/storageConnections.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = getSessionFromRequest(req as any);
  if (!session) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    if (req.method === "GET") {
      const connections = await listStorageConnections();
      return res.status(200).json(connections);
    }

    const parsed = parseCreateConnectionPayload(req.body);
    const connection = await createStorageConnection(parsed);
    return res.status(200).json({ success: true, connection });
  } catch (error: any) {
    const message = String(error?.message || error);
    const isValidation = [
      "Request body must be an object",
      "provider must be backblaze_b2 or aws_s3",
      "name is required",
      "bucket is required",
      "endpoint is required for backblaze_b2",
    ].includes(message);

    if (isValidation) {
      return res.status(400).json({ error: message });
    }

    console.error("STORAGE_CONNECTIONS_INDEX_ERROR", error);
    return res.status(500).json({ error: "Failed to process request" });
  }
}
