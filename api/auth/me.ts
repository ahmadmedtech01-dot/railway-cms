import { type VercelRequest, type VercelResponse } from "@vercel/node";
import { getSessionFromRequest } from "../_lib/auth.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const session = getSessionFromRequest(req as any);
    if (!session) {
      return res.status(401).json({ ok: false, error: "Not authenticated" });
    }
    res.json({ id: session.adminId, email: session.adminEmail });
  } catch (err: any) {
    console.error("AUTH_ME_ERROR", err);
    return res.status(500).json({ ok: false, error: "Authentication check failed" });
  }
}
