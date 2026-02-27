import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSessionFromRequest } from "../_lib/auth.js";
import { deleteStorageConnection } from "../_lib/storageConnections.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "DELETE") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = getSessionFromRequest(req as any);
  if (!session) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const id = String(req.query.id || "").trim();
    if (!id) {
      return res.status(400).json({ error: "id is required" });
    }

    const deleted = await deleteStorageConnection(id);
    if (!deleted) {
      return res.status(404).json({ error: "Connection not found" });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("STORAGE_CONNECTION_DELETE_ERROR", error);
    return res.status(500).json({ error: "Failed to delete connection" });
  }
}
