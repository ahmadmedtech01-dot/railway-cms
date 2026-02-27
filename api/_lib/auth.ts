import jwt from "jsonwebtoken";
import { type Request, type Response } from "express";

const SESSION_SECRET = process.env.SESSION_SECRET || "secure-video-cms-secret";
const COOKIE_NAME = "auth_session";
const SESSION_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface AuthSession {
  adminId: string;
  adminEmail: string;
}

export function signSession(payload: AuthSession): string {
  return jwt.sign(payload, SESSION_SECRET, { expiresIn: "7d" });
}

export function verifySession(token: string): AuthSession | null {
  try {
    const decoded = jwt.verify(token, SESSION_SECRET) as any;
    if (decoded && typeof decoded === "object" && decoded.adminId && decoded.adminEmail) {
      return {
        adminId: String(decoded.adminId),
        adminEmail: String(decoded.adminEmail),
      };
    }
  } catch (err) {
    // Invalid or expired token
  }
  return null;
}

export function getSessionFromRequest(req: Request): AuthSession | null {
  const cookies = req.headers.cookie;
  if (!cookies) return null;

  const match = cookies.match(new RegExp(`(^|;)\\s*${COOKIE_NAME}=([^;]+)`));
  const token = match ? match[2] : null;

  if (!token) return null;
  return verifySession(token);
}

export function setSessionCookie(res: Response, token: string) {
  const isProduction = process.env.NODE_ENV === "production" || !!process.env.VERCEL;

  const options = [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_EXPIRY / 1000}`,
  ];

  if (isProduction) {
    options.push("Secure");
  }

  res.setHeader("Set-Cookie", options.join("; "));
}

export function clearSessionCookie(res: Response) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
  );
}

export function requireAuth(req: Request, res: Response, next: () => void) {
  const session = getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  (req as any).authSession = session;
  next();
}
