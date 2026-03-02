export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (!env.SIGNING_SECRET) {
      return new Response("Server misconfiguration: SIGNING_SECRET is required", { status: 500 });
    }
    if (!env.ORIGIN_BASE) {
      return new Response("Server misconfiguration: ORIGIN_BASE is required", { status: 500 });
    }

    const routeMatch = url.pathname.match(/^\/(hls|seg|key)\/([^/]+)(\/.*)?$/);
    if (!routeMatch) {
      return new Response("Not found", { status: 404 });
    }

    const routeType = routeMatch[1];
    const publicId = routeMatch[2];
    const subPath = routeMatch[3] || "";

    const sid = url.searchParams.get("sid");
    const st = url.searchParams.get("st");
    const exp = url.searchParams.get("exp");

    if (!sid || !st || !exp) {
      return jsonResponse(401, { code: "PLAYBACK_DENIED", message: "Missing auth params" });
    }

    const expNum = parseInt(exp, 10);
    const now = Math.floor(Date.now() / 1000);
    // Playlists (hls) get a 30s clock-skew window; segments/keys get 15s
    const expiryTolerance = routeType === "hls" ? 30 : 15;
    if (now > expNum + expiryTolerance) {
      return jsonResponse(403, { code: "TOKEN_EXPIRED", message: "Token expired" });
    }

    const ua = request.headers.get("user-agent") || "unknown-ua";
    const shortDevice = await computeDeviceHash(ua);

    const candidatePaths = [subPath, url.pathname];
    if (routeType === "key") {
      candidatePaths.push("/key", "/enc.key");
    }

    let valid = false;
    for (const rp of candidatePaths) {
      if (await verifyHmac(env.SIGNING_SECRET, `${sid}|${rp}|${exp}|${shortDevice}`, st)) { valid = true; break; }
      if (await verifyHmac(env.SIGNING_SECRET, `${sid}|${rp}|${exp}`, st)) { valid = true; break; }
    }

    if (!valid) {
      console.log(`[gw] INVALID_TOKEN: route=${routeType} publicId=${publicId} subPath=${subPath}`);
      return jsonResponse(403, { code: "INVALID_TOKEN", message: "Invalid signature" });
    }

    const upstream = `${env.ORIGIN_BASE.replace(/\/+$/, "")}${url.pathname}${url.search}`;

    try {
      const upstreamReq = new Request(upstream, {
        method: request.method,
        headers: request.headers,
        redirect: "manual",
      });

      const railwayResp = await fetch(upstreamReq);

      // For segments, Railway returns 302 to a B2 presigned URL.
      // Follow the redirect ourselves so bytes flow B2 → Worker → Browser
      // (B2-Cloudflare egress is free via Bandwidth Alliance).
      if (railwayResp.status === 302 || railwayResp.status === 301) {
        const location = railwayResp.headers.get("Location");
        if (!location) {
          return new Response("Missing redirect location", { status: 502 });
        }
        const b2Resp = await fetch(location, { method: "GET" });
        const respHeaders = new Headers();
        respHeaders.set("Content-Type", b2Resp.headers.get("Content-Type") || "application/octet-stream");
        if (b2Resp.headers.get("Content-Length")) {
          respHeaders.set("Content-Length", b2Resp.headers.get("Content-Length"));
        }
        respHeaders.set("Access-Control-Allow-Origin", "*");
        respHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        respHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type");
        respHeaders.set("Cache-Control", "no-store");
        console.log(`[gw] ${routeType} ${publicId}${subPath} -> 302 -> B2 ${b2Resp.status}`);
        return new Response(b2Resp.body, { status: b2Resp.status, headers: respHeaders });
      }

      const respHeaders = new Headers(railwayResp.headers);
      respHeaders.set("Access-Control-Allow-Origin", "*");
      respHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      respHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type");
      respHeaders.set("Cache-Control", "no-store");

      console.log(`[gw] ${routeType} ${publicId}${subPath} -> ${railwayResp.status}`);

      return new Response(railwayResp.body, {
        status: railwayResp.status,
        headers: respHeaders,
      });
    } catch (e) {
      console.log(`[gw] upstream error: ${e.message}`);
      return new Response("Upstream error", { status: 502 });
    }
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

async function computeDeviceHash(ua) {
  const data = new TextEncoder().encode(ua);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  return hashHex.slice(0, 16);
}

async function verifyHmac(secret, payload, expected) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const sigHex = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  if (sigHex.length !== expected.length) return false;
  let match = true;
  for (let i = 0; i < sigHex.length; i++) {
    if (sigHex[i] !== expected[i]) match = false;
  }
  return match;
}
