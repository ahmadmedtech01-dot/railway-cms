import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSessionFromRequest } from "../../_lib/auth.js";
import { getStorageConnectionById, testStorageConnection } from "../../_lib/storageConnections.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const session = getSessionFromRequest(req as any);
  if (!session) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const id = String(req.query.id || "").trim();
    if (!id) {
      return res.status(400).json({ ok: false, error: "id is required" });
    }

    const connection = await getStorageConnectionById(id);
    if (!connection) {
      return res.status(404).json({ ok: false, error: "Connection not found" });
    }

    const result = await testStorageConnection(connection);
    return res.status(200).json(result);
  } catch (error) {
    console.error("STORAGE_CONNECTION_TEST_HANDLER_ERROR", error);
    return res.status(500).json({ ok: false, error: "Failed to test connection" });
  }
}
