// MediaSource / SourceBuffer guard.
//
// CocoCut-style downloaders work by hooking window.MediaSource and
// SourceBuffer.prototype.appendBuffer to intercept the decoded media payload
// after our HLS proxy hands it to the player. We can't prevent a determined
// attacker from doing that — but we can detect when our own globals have been
// replaced or wrapped (typical signs: a non-native function string, an
// unexpected toString descriptor, or our own probe getting different bytes
// echoed back).
//
// When tampering is detected we POST /api/player/:publicId/security-event
// which lets the server revoke the session.
//
// This module is best-effort — it never throws and never breaks playback.

type GuardOptions = {
  publicId: string;
  getSid: () => string;
  enabled: boolean;
};

const NATIVE_FN_RE = /\{\s*\[native code\]\s*\}/;

function isLikelyNative(fn: unknown): boolean {
  try {
    if (typeof fn !== "function") return false;
    return NATIVE_FN_RE.test(Function.prototype.toString.call(fn));
  } catch {
    return false;
  }
}

let installed = false;

export function installMediaSourceGuard(opts: GuardOptions): () => void {
  if (!opts.enabled || installed || typeof window === "undefined") return () => {};
  installed = true;

  const reported = new Set<string>();
  const report = (eventType: string, meta?: any) => {
    if (reported.has(eventType)) return;
    reported.add(eventType);
    try {
      const sid = opts.getSid?.() || "";
      fetch(`/api/player/${opts.publicId}/security-event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({ sid, eventType, meta }),
      }).catch(() => {});
    } catch {}
  };

  const w = window as any;

  // Snapshot the native references BEFORE any 3rd-party script tampers further.
  const NativeMediaSource = w.MediaSource;
  const NativeSourceBuffer = w.SourceBuffer;
  const nativeAppendBuffer = NativeSourceBuffer?.prototype?.appendBuffer;
  const nativeAddSourceBuffer = NativeMediaSource?.prototype?.addSourceBuffer;
  const nativeEndOfStream = NativeMediaSource?.prototype?.endOfStream;
  const NativeURL = w.URL;
  const nativeCreateObjectURL = NativeURL?.createObjectURL;
  const nativeRevokeObjectURL = NativeURL?.revokeObjectURL;

  // ── Initial snapshot checks ──────────────────────────────────────────────
  if (NativeMediaSource && !isLikelyNative(NativeMediaSource)) {
    report("MEDIA_SOURCE_HOOK_DETECTED", { stage: "snapshot", reason: "MediaSource not native" });
  }
  if (nativeAppendBuffer && !isLikelyNative(nativeAppendBuffer)) {
    report("APPEND_BUFFER_HOOK_DETECTED", { stage: "snapshot", reason: "appendBuffer not native" });
  }
  if (nativeAddSourceBuffer && !isLikelyNative(nativeAddSourceBuffer)) {
    report("MEDIA_SOURCE_HOOK_DETECTED", { stage: "snapshot", reason: "addSourceBuffer not native" });
  }
  if (nativeEndOfStream && !isLikelyNative(nativeEndOfStream)) {
    report("MEDIA_SOURCE_HOOK_DETECTED", { stage: "snapshot", reason: "endOfStream not native" });
  }
  if (nativeCreateObjectURL && !isLikelyNative(nativeCreateObjectURL)) {
    report("HLS_URL_EXPOSURE_PREVENTED", { stage: "snapshot", reason: "URL.createObjectURL not native" });
  }
  if (nativeRevokeObjectURL && !isLikelyNative(nativeRevokeObjectURL)) {
    report("HLS_URL_EXPOSURE_PREVENTED", { stage: "snapshot", reason: "URL.revokeObjectURL not native" });
  }

  // ── Periodic re-check for runtime tampering ──────────────────────────────
  const checkInterval = window.setInterval(() => {
    try {
      if (w.MediaSource && w.MediaSource !== NativeMediaSource) {
        report("MEDIA_SOURCE_HOOK_DETECTED", { stage: "runtime", reason: "MediaSource replaced" });
      }
      const curAppend = w.SourceBuffer?.prototype?.appendBuffer;
      if (curAppend && curAppend !== nativeAppendBuffer) {
        report("APPEND_BUFFER_HOOK_DETECTED", { stage: "runtime", reason: "appendBuffer replaced" });
      } else if (curAppend && !isLikelyNative(curAppend)) {
        report("APPEND_BUFFER_HOOK_DETECTED", { stage: "runtime", reason: "appendBuffer wrapped" });
      }
      const curAdd = w.MediaSource?.prototype?.addSourceBuffer;
      if (curAdd && curAdd !== nativeAddSourceBuffer) {
        report("MEDIA_SOURCE_HOOK_DETECTED", { stage: "runtime", reason: "addSourceBuffer replaced" });
      }
      const curEnd = w.MediaSource?.prototype?.endOfStream;
      if (curEnd && curEnd !== nativeEndOfStream) {
        report("MEDIA_SOURCE_HOOK_DETECTED", { stage: "runtime", reason: "endOfStream replaced" });
      }
      const curCreate = w.URL?.createObjectURL;
      if (curCreate && curCreate !== nativeCreateObjectURL) {
        report("HLS_URL_EXPOSURE_PREVENTED", { stage: "runtime", reason: "URL.createObjectURL replaced" });
      } else if (curCreate && !isLikelyNative(curCreate)) {
        report("HLS_URL_EXPOSURE_PREVENTED", { stage: "runtime", reason: "URL.createObjectURL wrapped" });
      }
      const curRevoke = w.URL?.revokeObjectURL;
      if (curRevoke && curRevoke !== nativeRevokeObjectURL) {
        report("HLS_URL_EXPOSURE_PREVENTED", { stage: "runtime", reason: "URL.revokeObjectURL replaced" });
      }
    } catch {}
  }, 4000);

  return () => {
    installed = false;
    window.clearInterval(checkInterval);
  };
}

export function reportSecurityEvent(publicId: string, sid: string, eventType: string, meta?: any) {
  try {
    fetch(`/api/player/${publicId}/security-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({ sid, eventType, meta }),
    }).catch(() => {});
  } catch {}
}
