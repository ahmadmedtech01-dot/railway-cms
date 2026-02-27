import { type VercelRequest, type VercelResponse } from "@vercel/node";
import bcrypt from "bcryptjs";
import { db } from "../_lib/db.js";
import { adminUsers } from "../_lib/schema.js";
import { eq } from "drizzle-orm";
import { signSession, setSessionCookie } from "../_lib/auth.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ ok: false, error: "Email and password required" });
    if (password.length < 8) return res.status(400).json({ ok: false, error: "Password must be at least 8 characters" });

    // Check existing
    const [existing] = await db.select().from(adminUsers).where(eq(adminUsers.email, email)).limit(1);
    if (existing) {
      return res.status(409).json({ ok: false, error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const [admin] = await db.insert(adminUsers).values({ email, passwordHash }).returning();

    const token = signSession({ adminId: admin.id, adminEmail: admin.email });
    setSessionCookie(res as any, token);

    return res.status(201).json({ ok: true, email: admin.email });
  } catch (err: any) {
    console.error("REGISTER_ERROR", err);
    return res.status(500).json({ ok: false, error: "Registration failed", detail: String(err?.message || err) });
  }
}
