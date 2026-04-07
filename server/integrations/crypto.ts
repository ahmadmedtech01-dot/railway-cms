import crypto from "crypto";

export function generateClientKey(): string {
  return `syan_ck_${crypto.randomBytes(24).toString("hex")}`;
}

export function generateClientSecret(): string {
  return `syan_cs_${crypto.randomBytes(32).toString("hex")}`;
}

export function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

export function verifySecret(secret: string, hash: string): boolean {
  const computed = hashSecret(secret);
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function verifyHmacLaunchToken(
  token: string,
  clientSecretHash: string,
  rawSecretForVerify?: string
): { payload: Record<string, any>; valid: boolean } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [payloadB64, sig] = parts;
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (!rawSecretForVerify) return null;
    const expectedSig = crypto.createHmac("sha256", rawSecretForVerify).update(payloadB64).digest("hex");
    const sigBuf = Buffer.from(sig, "hex");
    const expectedBuf = Buffer.from(expectedSig, "hex");
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return { payload, valid: false };
    }
    return { payload, valid: true };
  } catch {
    return null;
  }
}

export function signIntegrationPayload(payload: Record<string, any>, secret: string): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest("hex");
  return `${payloadB64}.${sig}`;
}
