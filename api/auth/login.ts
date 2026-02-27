import { type VercelRequest, type VercelResponse } from "@vercel/node";
import bcrypt from "bcryptjs";
import { signSession, setSessionCookie } from "../_lib/auth.js";

function parseCredentials(body: unknown): { email: string; password: string } {
  if (!body || typeof body !== "object") {
    return { email: "", password: "" };
  }

  const input = body as Record<string, unknown>;
  return {
    email: typeof input.email === "string" ? input.email.trim() : "",
    password: typeof input.password === "string" ? input.password : "",
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const { email, password } = parseCredentials(req.body);
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "Email and password required" });
    }

    // 1) Prefer environment credentials so admin login still works
    //    when database connectivity is unavailable on Vercel.
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (adminEmail && adminPassword && email === adminEmail && password === adminPassword) {
      const token = signSession({ adminId: "admin-env", adminEmail: adminEmail });
      setSessionCookie(res as any, token);
      return res.json({ ok: true, email: adminEmail });
    }

    // 2) Fall back to database-backed admin users.
    const hasDbUrl = Boolean(process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL);
    if (hasDbUrl) {
      const [{ db }, { adminUsers }, { eq }] = await Promise.all([
        import("../_lib/db.js"),
        import("../_lib/schema.js"),
        import("drizzle-orm"),
      ]);

      const [admin] = await db.select().from(adminUsers).where(eq(adminUsers.email, email)).limit(1);
      if (admin) {
        const valid = await bcrypt.compare(password, admin.passwordHash);
        if (valid) {
          const token = signSession({ adminId: admin.id, adminEmail: admin.email });
          setSessionCookie(res as any, token);
          return res.json({ ok: true, email: admin.email });
        }
      }
    }

    return res.status(401).json({ ok: false, error: "Invalid credentials" });
  } catch (err: any) {
    console.error("LOGIN_ERROR", err);
    return res.status(500).json({ ok: false, error: "Login failed", detail: String(err?.message || err) });
  }
}
