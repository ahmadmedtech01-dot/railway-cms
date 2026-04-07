import type { IntegrationLaunchPayload } from "./types";

const REQUIRED_FIELDS: (keyof IntegrationLaunchPayload)[] = ["iss", "aud", "sub", "publicId", "exp", "iat", "jti"];

export function validateLaunchPayload(
  payload: Record<string, any>
): { valid: true; parsed: IntegrationLaunchPayload } | { valid: false; code: string; message: string } {
  const missing = REQUIRED_FIELDS.filter((f) => !payload[f] && payload[f] !== 0);
  if (missing.length > 0) {
    return { valid: false, code: "VALIDATION_ERROR", message: `Missing required fields: ${missing.join(", ")}` };
  }

  if (payload.aud !== "cms-player") {
    return { valid: false, code: "VALIDATION_ERROR", message: `aud must be "cms-player"` };
  }

  if (typeof payload.exp !== "number" || typeof payload.iat !== "number") {
    return { valid: false, code: "VALIDATION_ERROR", message: "exp and iat must be numbers" };
  }

  const nowSec = Date.now() / 1000;
  if (nowSec > payload.exp) {
    return { valid: false, code: "LAUNCH_TOKEN_EXPIRED", message: `Token expired ${Math.round(nowSec - payload.exp)}s ago` };
  }

  if (payload.exp - nowSec > 600) {
    return { valid: false, code: "VALIDATION_ERROR", message: `Token exp is too far in the future (max 600s)` };
  }

  return {
    valid: true,
    parsed: {
      iss: String(payload.iss),
      aud: String(payload.aud),
      sub: String(payload.sub),
      publicId: String(payload.publicId),
      courseId: payload.courseId ? String(payload.courseId) : undefined,
      lessonId: payload.lessonId ? String(payload.lessonId) : undefined,
      sessionId: payload.sessionId ? String(payload.sessionId) : undefined,
      name: payload.name ? String(payload.name) : undefined,
      email: payload.email ? String(payload.email) : undefined,
      permissions: payload.permissions || undefined,
      startAt: typeof payload.startAt === "number" ? payload.startAt : undefined,
      origin: payload.origin ? String(payload.origin) : undefined,
      exp: payload.exp,
      iat: payload.iat,
      jti: String(payload.jti),
    },
  };
}
