import { type VercelRequest, type VercelResponse } from "@vercel/node";
import { clearSessionCookie } from "../_lib/auth.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    clearSessionCookie(res as any);
    return res.json({ ok: true });
  } catch (err: any) {
    console.error("LOGOUT_ERROR", err);
    return res.status(500).json({ ok: false, error: "Logout failed" });
  }
}
