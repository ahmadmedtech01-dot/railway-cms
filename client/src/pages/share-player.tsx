import { useEffect, useRef, useState } from "react";
import { useParams } from "wouter";
import EmbedPlayerPage from "./embed-player";
import { setBootstrapToken, getBootstrapToken, getBootstrapPublicId } from "@/lib/bootstrap-token";

export default function SharePlayerPage() {
  const params = useParams<{ publicId?: string; shareCode?: string }>();
  const publicId = params.publicId;
  const shareCode = params.shareCode;

  // If a legacy ?token= is in the URL, the embed-player will pick it up and
  // strip it from the address bar via history.replaceState. We still attempt
  // bootstrap on the modern clean URL path.
  const hasUrlToken = typeof window !== "undefined" &&
    /[?&](token|embedToken)=/.test(window.location.search);

  const [status, setStatus] = useState<"loading" | "ready" | "error" | "password">(
    hasUrlToken ? "ready" : "loading"
  );
  const [errorMsg, setErrorMsg] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resolvedPublicId, setResolvedPublicId] = useState<string | null>(publicId || null);
  const attemptedRef = useRef(false);

  const callBootstrap = async (pw?: string) => {
    setSubmitting(true);
    try {
      const url = shareCode
        ? `/api/share/${encodeURIComponent(shareCode)}/bootstrap`
        : `/api/player/${encodeURIComponent(publicId || "")}/bootstrap`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(pw ? { password: pw } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.code === "SHARE_LINK_PASSWORD_REQUIRED" || data.code === "SHARE_LINK_PASSWORD_INVALID") {
          setStatus("password");
          setErrorCode(data.code);
          setErrorMsg(data.code === "SHARE_LINK_PASSWORD_INVALID" ? "Incorrect password." : "");
          setSubmitting(false);
          return;
        }
        setStatus("error");
        setErrorCode(data.code || "");
        setErrorMsg(data.message || "Could not load video.");
        setSubmitting(false);
        return;
      }
      setBootstrapToken(data.token, data.publicId);
      setResolvedPublicId(data.publicId);
      // If the URL is /watch/:shareCode or /s/:shareCode, normalize to /v/:publicId
      // so the embed-player can use its usual publicId param. Also strip any token.
      if (shareCode && data.publicId) {
        try { window.history.replaceState({}, "", `/v/${data.publicId}`); } catch {}
      }
      setStatus("ready");
      setSubmitting(false);
    } catch (e: any) {
      setStatus("error");
      setErrorMsg(e?.message || "Network error");
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (hasUrlToken || attemptedRef.current) return;
    attemptedRef.current = true;
    // CRITICAL: if a bootstrap token is already in the module-level singleton,
    // reuse it instead of calling /bootstrap again. This is the fix for the
    // "duplicate bootstrap → new session SID → MSE flush → 3-5s black screen"
    // cycle visible in Railway logs. It happens because:
    //   1. /watch/:shareCode bootstrap succeeds and writes token to singleton
    //   2. We call history.replaceState to rewrite URL to /v/:publicId below
    //   3. Wouter sees the route change and remounts SharePlayerPage
    //   4. New instance hits this effect with a fresh attemptedRef
    //   5. Without this guard, we'd call /bootstrap again, mint a new session,
    //      and force the player to swap manifests mid-playback.
    // Also: removed the `clearBootstrapToken` cleanup. The previous cleanup
    // wiped the singleton on every unmount, defeating singleton survival
    // across remounts. The token lifetime is the page session — a hard
    // navigation/refresh resets module state anyway.
    const existing = getBootstrapToken();
    const existingPid = getBootstrapPublicId();
    if (existing && (!publicId || existingPid === publicId)) {
      if (existingPid) setResolvedPublicId(existingPid);
      setStatus("ready");
      return;
    }
    callBootstrap();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === "loading") {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-300">
        <div className="text-sm">Loading secure player…</div>
      </div>
    );
  }

  if (status === "password") {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
        <form
          className="w-full max-w-sm bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4"
          onSubmit={(e) => { e.preventDefault(); if (password) callBootstrap(password); }}
        >
          <h2 className="text-lg font-semibold text-white">Password required</h2>
          <p className="text-sm text-gray-400">This video is protected. Enter the password to continue.</p>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoFocus
            className="w-full px-3 py-2 rounded-md bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            data-testid="input-share-password"
          />
          {errorMsg && <div className="text-sm text-red-400">{errorMsg}</div>}
          <button
            type="submit"
            disabled={submitting || !password}
            className="w-full py-2 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium"
            data-testid="button-share-password-submit"
          >
            {submitting ? "Verifying…" : "Watch video"}
          </button>
        </form>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
        <div className="max-w-md text-center space-y-3">
          <h2 className="text-xl font-semibold text-white">Video unavailable</h2>
          <p className="text-sm text-gray-400">{errorMsg || "This share link is not available."}</p>
          {errorCode && <p className="text-xs text-gray-600 font-mono">{errorCode}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      <div className="flex-1">
        <EmbedPlayerPage forcePublicId={resolvedPublicId || undefined} />
      </div>
    </div>
  );
}
