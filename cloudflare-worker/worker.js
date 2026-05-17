export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (!env.ORIGIN_BASE) {
      return new Response("Server misconfiguration: ORIGIN_BASE is required", { status: 500 });
    }

    // Stealth routes: opaque-ID based playlist/chunk/key URLs.
    // The opaque ID is AES-encrypted at the origin; the Worker cannot (and
    // must not) verify it — the origin decodes & validates session, UA,
    // window, abuse, etc. The Worker is a transparent CDN passthrough that
    // hides the Railway origin and puts an edge in front of every request.
    const stealthMatch = url.pathname.match(/^\/api\/player\/([^/]+)\/stream\/(window|chunk|secret)\/([^/?#]+)\/?$/);
    if (stealthMatch) {
      return proxyStealth(request, env, url, stealthMatch[2], stealthMatch[1], stealthMatch[3], ctx, env.SIGNING_SECRET);
    }

    // Legacy signed routes: /hls /seg /key with HMAC verification.
    const routeMatch = url.pathname.match(/^\/(hls|seg|key)\/([^/]+)(\/.*)?$/);
    if (!routeMatch) {
      return new Response("Not found", { status: 404 });
    }

    if (!env.SIGNING_SECRET) {
      return new Response("Server misconfiguration: SIGNING_SECRET is required", { status: 500 });
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

    // ── SYNTHETIC EDGE CACHE FOR /seg/ ONLY ───────────────────────────
    // Master-encrypted segment bytes from B2 are identical for every
    // viewer of the same video. Caching them at the edge collapses
    // 1000 viewers × N segments into N origin fetches.
    // Hard scoping:
    //   • Only /seg/ — never /hls/ (per-session URLs) or /key/ (per-session keys).
    //   • Only GET — Range requests bypass cache in v1 (HLS.js doesn't issue them on .ts).
    //   • Only 200 responses cached — 4xx/5xx/206 never cached.
    //   • Cache key strips ALL per-request params (sid, st, exp) — stable across users.
    //   • Validation already ran above; cache lookup happens AFTER auth.
    // Browser always receives `Cache-Control: private, no-store` so token
    // rotation and per-user binding stay enforceable.
    //
    // ── REVOCATION LATENCY (accepted trade-off) ───────────────────────
    // On cache HIT, the Worker does NOT consult Railway, so session
    // revocations enforced ONLY at the segment endpoint are delayed by
    // up to TOKEN_TTL (15s skew window above). This is acceptable because:
    //   1. Segment signed URLs have 60s TTL max — a revoked session can
    //      replay at most the segments it already holds signed URLs for.
    //   2. The /hls/ variant playlist is NEVER cached, is fetched every
    //      few seconds by hls.js (EVENT-style), and is the chokepoint
    //      where Railway enforces SESSION_REVOKED / abuse blocks / kill
    //      switch. Once the playlist is denied, no new signed segment
    //      URLs are issued — existing tokens expire within seconds and
    //      the player gets no further URLs to even attempt cache lookup.
    //   3. The AES /key/ endpoint is NEVER cached — re-fetched per session.
    //      A revoked session loses key access immediately, making any
    //      cached bytes undecryptable to a fresh browser context.
    // Net effect: max ~15s of continued playback on already-issued URLs
    // after revocation — same window the short-TTL design accepts today.
    const canEdgeCache =
      routeType === "seg" &&
      request.method === "GET" &&
      !request.headers.get("range");

    let edgeCache = null;
    let cacheKeyReq = null;
    if (canEdgeCache) {
      edgeCache = caches.default;
      // Synthetic cache URL — stable identity = publicId + subPath (which
      // already encodes variant/quality + segment index). No query string,
      // no token, no expiry. Two viewers of segment 042 of video XYZ at
      // 720p will hit the same key regardless of their individual sids.
      const syntheticUrl = `https://cache.internal/seg/${publicId}${subPath}`;
      cacheKeyReq = new Request(syntheticUrl, { method: "GET" });

      const cached = await edgeCache.match(cacheKeyReq);
      if (cached) {
        // HIT — return cached bytes WITHOUT touching Railway or B2.
        // Synthesize fresh per-request headers (CORS + no-store for browser).
        const respHeaders = new Headers();
        const passthrough = ["content-type", "content-length", "accept-ranges"];
        for (const h of passthrough) {
          const v = cached.headers.get(h);
          if (v) respHeaders.set(h, v);
        }
        if (!respHeaders.has("content-type")) {
          respHeaders.set("content-type", "application/octet-stream");
        }
        respHeaders.set("Access-Control-Allow-Origin", "*");
        respHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        respHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type");
        respHeaders.set("Cache-Control", "private, no-store");
        respHeaders.set("cf-cache-status", "HIT");
        console.log(`[gw] seg ${publicId}${subPath} CACHE HIT`);
        return new Response(cached.body, { status: 200, headers: respHeaders });
      }
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
        // Forward Range header to B2 so partial-content (206) requests
        // behave correctly. Without this, an iOS Safari Range request would
        // get a full 200 body instead of the requested byte range.
        const b2Headers = {};
        const rangeHeader = request.headers.get("range");
        if (rangeHeader) b2Headers["Range"] = rangeHeader;
        const b2Resp = await fetch(location, { method: "GET", headers: b2Headers });
        const respHeaders = new Headers();
        respHeaders.set("Content-Type", b2Resp.headers.get("Content-Type") || "application/octet-stream");
        if (b2Resp.headers.get("Content-Length")) {
          respHeaders.set("Content-Length", b2Resp.headers.get("Content-Length"));
        }
        if (b2Resp.headers.get("Content-Range")) {
          respHeaders.set("Content-Range", b2Resp.headers.get("Content-Range"));
        }
        if (b2Resp.headers.get("Accept-Ranges")) {
          respHeaders.set("Accept-Ranges", b2Resp.headers.get("Accept-Ranges"));
        }
        respHeaders.set("Access-Control-Allow-Origin", "*");
        respHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        respHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type");
        respHeaders.set("Cache-Control", "private, no-store");

        // ── CACHE MISS → STORE ────────────────────────────────────────
        // Only successful 200 responses for /seg/ get cached. The cached
        // copy carries INTERNAL `public, max-age=86400, immutable` headers
        // (it's content-addressed — segment_042 of video XYZ at 720p
        // never changes). The browser response (above) stays no-store.
        // We tee the body: one stream to the browser, one to the cache.
        if (edgeCache && cacheKeyReq && b2Resp.status === 200 && b2Resp.body) {
          const [browserStream, cacheStream] = b2Resp.body.tee();
          const cacheHeaders = new Headers();
          cacheHeaders.set("Content-Type", b2Resp.headers.get("Content-Type") || "application/octet-stream");
          if (b2Resp.headers.get("Content-Length")) {
            cacheHeaders.set("Content-Length", b2Resp.headers.get("Content-Length"));
          }
          cacheHeaders.set("Cache-Control", "public, max-age=86400, immutable");
          const cacheable = new Response(cacheStream, { status: 200, headers: cacheHeaders });
          // ctx.waitUntil keeps the cache write alive past response return,
          // giving deterministic cache fill instead of best-effort.
          const putPromise = edgeCache.put(cacheKeyReq, cacheable)
            .catch(e => console.log(`[gw] cache.put failed: ${e.message}`));
          if (ctx && typeof ctx.waitUntil === "function") {
            ctx.waitUntil(putPromise);
          }
          respHeaders.set("cf-cache-status", "MISS");
          console.log(`[gw] seg ${publicId}${subPath} CACHE MISS → stored (${b2Resp.headers.get("Content-Length") || "?"} bytes)`);
          return new Response(browserStream, { status: 200, headers: respHeaders });
        }

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

// Stealth-route proxy. The origin owns all auth (session, UA, window, abuse,
// kill switch). Worker forwards requests preserving headers (User-Agent,
// Range, etc.). For chunk requests the origin has already validated, the
// Worker also runs a synthetic edge cache keyed by a stable 16-hex prefix
// embedded in the opaque ID (computed server-side as
// HMAC(SIGNING_SECRET, "chunk|publicId|segSubPath")). The prefix is the
// SAME for every viewer of the same segment of the same video, so the cache
// collapses N viewers × M segments down to M origin fetches.
//
// ── WHAT IS CACHED ────────────────────────────────────────────────────
//   • Stealth chunk (kind="chunk") successful 200 responses, GET only,
//     no Range header, opaque ID carries the 16-hex stable prefix.
// ── WHAT IS NEVER CACHED ──────────────────────────────────────────────
//   • Stealth playlist (kind="window") — per-session, per-window content.
//   • Stealth key (kind="secret") — per-session AES key material.
//   • 4xx / 5xx / 206 responses.
//   • Any Range request.
//   • Old-format opaque IDs without the 16-hex prefix (backward compat).
// ── BROWSER RESPONSE ──────────────────────────────────────────────────
// Always `Cache-Control: private, no-store` regardless of HIT/MISS so
// token rotation and per-user session binding remain enforceable. Only
// the INTERNAL cached copy carries `public, max-age=86400, immutable`.
// ── REVOCATION LATENCY ────────────────────────────────────────────────
// Same trade-off as /seg/: on cache HIT the Worker skips Railway, so
// revocations enforced ONLY at the chunk endpoint are delayed by up to
// the segment TTL window. The stealth playlist (/stream/window) is
// NEVER cached and is the chokepoint for SESSION_REVOKED / kill switch
// / abuse blocks. Once the playlist is denied, no new opaque chunk URLs
// are minted and the player runs out of valid URLs within seconds.
async function proxyStealth(request, env, url, kind, publicId, opaqueId, ctx, signingSecret) {
  const upstream = `${env.ORIGIN_BASE.replace(/\/+$/, "")}${url.pathname}${url.search}`;
  try {
    // ── EDGE CACHE LOOKUP (chunk only) ───────────────────────────────
    // BEFORE cache.match we MUST validate `st` (HMAC) and `exp` so a
    // stolen-URL replay attacker cannot keep pulling cached bytes after
    // their session is revoked. Without this gate, cache.match returns
    // bytes for any holder of a prefix for up to 24h.
    //
    // The opaque ID has been minted by the origin with format:
    //   <16hex stableKey><existing-encrypted-opaque>
    // URL also carries ?st=<hmac-hex>&exp=<unix>. The HMAC is computed as
    // HMAC-SHA256(SIGNING_SECRET, "chunk-cache-v1|publicId|prefix|exp").
    // Same secret on origin and Worker — neither can be forged without it.
    const STABLE_PREFIX_LEN = 16;
    const HEX_RE = /^[0-9a-f]+$/i;
    const st = url.searchParams.get("st");
    const expStr = url.searchParams.get("exp");
    let canEdgeCache =
      kind === "chunk" &&
      request.method === "GET" &&
      !request.headers.get("range") &&
      typeof opaqueId === "string" &&
      opaqueId.length > STABLE_PREFIX_LEN + 60 &&
      HEX_RE.test(opaqueId) &&
      !!st && !!expStr && !!signingSecret;

    let edgeCache = null;
    let cacheKeyReq = null;
    if (canEdgeCache) {
      const stablePrefix = opaqueId.slice(0, STABLE_PREFIX_LEN);
      const expNum = parseInt(expStr, 10);
      const now = Math.floor(Date.now() / 1000);
      // 15s skew window matches /seg/ behaviour. After exp + 15s the
      // URL is unusable AT THE EDGE — request is rejected before any
      // cache lookup and forwarded to origin (which will also reject).
      if (!Number.isFinite(expNum) || now > expNum + 15) {
        console.log(`[gw] stealth chunk ${publicId}/${stablePrefix} edge-expired (now=${now} exp=${expNum})`);
        return jsonResponse(403, { code: "TOKEN_EXPIRED", message: "Token expired" });
      }
      // Defense-in-depth: reject absurdly-future exp values (e.g. from a
      // mis-configured origin or a tampered token). Stealth chunk URLs are
      // minted with TTL ≤ TOKEN_TTL (~15 min) so anything more than 1h in
      // the future is invalid by construction.
      if (expNum - now > 3600) {
        console.log(`[gw] stealth chunk ${publicId}/${stablePrefix} exp-too-far-future (delta=${expNum - now}s)`);
        return jsonResponse(403, { code: "INVALID_TOKEN", message: "Exp out of range" });
      }
      const expectedSt = await hmacHex(signingSecret, `chunk-cache-v1|${publicId}|${stablePrefix}|${expNum}`);
      if (!timingSafeEqualHex(st, expectedSt)) {
        console.log(`[gw] stealth chunk ${publicId}/${stablePrefix} INVALID_TOKEN`);
        return jsonResponse(403, { code: "INVALID_TOKEN", message: "Invalid signature" });
      }
      edgeCache = caches.default;
      // Cache key is publicId + stablePrefix — fully scoped per video so
      // there is no cross-video collision risk. No sid, no exp, no token.
      const syntheticUrl = `https://cache.internal/stealth-chunk/${publicId}/${stablePrefix}`;
      cacheKeyReq = new Request(syntheticUrl, { method: "GET" });
      const cached = await edgeCache.match(cacheKeyReq);
      if (cached) {
        const respHeaders = new Headers();
        const passthrough = ["content-length", "accept-ranges"];
        for (const h of passthrough) {
          const v = cached.headers.get(h);
          if (v) respHeaders.set(h, v);
        }
        // Stealth contract: generic octet-stream content type to deny
        // scrapers a "video/MP2T" hint.
        respHeaders.set("Content-Type", "application/octet-stream");
        respHeaders.set("Access-Control-Allow-Origin", "*");
        respHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        respHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type");
        respHeaders.set("Cache-Control", "private, no-store");
        respHeaders.set("X-Content-Type-Options", "nosniff");
        respHeaders.set("cf-cache-status", "HIT");
        console.log(`[gw] stealth chunk ${publicId}/${stablePrefix} CACHE HIT`);
        return new Response(cached.body, { status: 200, headers: respHeaders });
      }
    }

    // Preserve method, headers (UA must match the originally-bound session),
    // and request body for any future POST stealth routes.
    const fwdHeaders = new Headers(request.headers);
    fwdHeaders.delete("host");

    const upstreamReq = new Request(upstream, {
      method: request.method,
      headers: fwdHeaders,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });

    const originResp = await fetch(upstreamReq);

    // If origin returns a 302 (e.g. future change to redirect chunks to B2
    // directly), follow it. Bytes flow Storage → Worker → Browser (and the
    // cache fill path below also captures them).
    if (kind === "chunk" && (originResp.status === 302 || originResp.status === 301)) {
      const location = originResp.headers.get("Location");
      if (!location) return new Response("Missing redirect location", { status: 502 });
      const storageResp = await fetch(location, {
        method: "GET",
        headers: request.headers.get("range") ? { Range: request.headers.get("range") } : undefined,
      });
      const respHeaders = buildChunkRespHeaders(storageResp);
      // Cache MISS → STORE (only successful 200 with body + cache key set).
      if (edgeCache && cacheKeyReq && storageResp.status === 200 && storageResp.body) {
        const [browserStream, cacheStream] = storageResp.body.tee();
        const cacheHeaders = new Headers();
        cacheHeaders.set("Content-Type", "application/octet-stream");
        const cl = storageResp.headers.get("Content-Length");
        if (cl) cacheHeaders.set("Content-Length", cl);
        cacheHeaders.set("Cache-Control", "public, max-age=86400, immutable");
        const cacheable = new Response(cacheStream, { status: 200, headers: cacheHeaders });
        const putPromise = edgeCache.put(cacheKeyReq, cacheable)
          .catch(e => console.log(`[gw] cache.put failed: ${e.message}`));
        if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(putPromise);
        respHeaders.set("cf-cache-status", "MISS");
        console.log(`[gw] stealth chunk ${publicId} -> 302 -> storage 200 CACHE MISS → stored`);
        return new Response(browserStream, { status: 200, headers: respHeaders });
      }
      console.log(`[gw] stealth ${kind} ${publicId} -> 302 -> storage ${storageResp.status}`);
      return new Response(storageResp.body, { status: storageResp.status, headers: respHeaders });
    }

    // Cache MISS path for streamed bytes (origin returns 200 + body directly).
    if (kind === "chunk" && edgeCache && cacheKeyReq && originResp.status === 200 && originResp.body) {
      const [browserStream, cacheStream] = originResp.body.tee();
      const cacheHeaders = new Headers();
      // Origin already stripped identifying headers; we mirror that for the
      // cached copy. Generic octet-stream + no other media hints.
      cacheHeaders.set("Content-Type", "application/octet-stream");
      const cl = originResp.headers.get("Content-Length");
      if (cl) cacheHeaders.set("Content-Length", cl);
      cacheHeaders.set("Cache-Control", "public, max-age=86400, immutable");
      const cacheable = new Response(cacheStream, { status: 200, headers: cacheHeaders });
      const putPromise = edgeCache.put(cacheKeyReq, cacheable)
        .catch(e => console.log(`[gw] cache.put failed: ${e.message}`));
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(putPromise);

      const respHeaders = new Headers();
      const passthrough = ["content-length", "accept-ranges"];
      for (const h of passthrough) {
        const v = originResp.headers.get(h);
        if (v) respHeaders.set(h, v);
      }
      respHeaders.set("Content-Type", "application/octet-stream");
      respHeaders.set("Access-Control-Allow-Origin", "*");
      respHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      respHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type");
      respHeaders.set("Cache-Control", "private, no-store");
      respHeaders.set("X-Content-Type-Options", "nosniff");
      respHeaders.set("cf-cache-status", "MISS");
      console.log(`[gw] stealth chunk ${publicId} CACHE MISS → stored (${cl || "?"} bytes)`);
      return new Response(browserStream, { status: 200, headers: respHeaders });
    }

    // Normal passthrough — non-cacheable cases (window, secret, 4xx/5xx,
    // 206 Range responses, old-format opaque IDs, etc.).
    const respHeaders = new Headers(originResp.headers);
    respHeaders.set("Access-Control-Allow-Origin", "*");
    respHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    respHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type");
    console.log(`[gw] stealth ${kind} ${publicId} -> ${originResp.status}`);
    return new Response(originResp.body, { status: originResp.status, headers: respHeaders });
  } catch (e) {
    console.log(`[gw] stealth upstream error: ${e.message}`);
    return new Response("Upstream error", { status: 502 });
  }
}

function buildChunkRespHeaders(storageResp) {
  const respHeaders = new Headers();
  respHeaders.set("Content-Type", "application/octet-stream");
  const passthrough = ["content-length", "content-range", "accept-ranges"];
  for (const h of passthrough) {
    const v = storageResp.headers.get(h);
    if (v) respHeaders.set(h, v);
  }
  respHeaders.set("Access-Control-Allow-Origin", "*");
  respHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  respHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type");
  respHeaders.set("Cache-Control", "private, no-store");
  respHeaders.set("X-Content-Type-Options", "nosniff");
  return respHeaders;
}

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

// Compute HMAC-SHA256 hex of (secret, payload). Used by the stealth-chunk
// edge gate to derive the expected st value.
async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time hex string compare. Prevents leaking the expected HMAC
// via response timing on the chunk cache edge gate.
function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
