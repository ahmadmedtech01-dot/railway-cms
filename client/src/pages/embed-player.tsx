import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useSearch } from "wouter";
import Hls from "hls.js";
import { useSecurityViolations, formatCountdown } from "@/security/useSecurityViolations";
import type { ViolationType } from "@/security/useSecurityViolations";
import { installMediaSourceGuard, reportSecurityEvent } from "@/lib/security/mediaSourceGuard";
import { getBootstrapToken } from "@/lib/bootstrap-token";

interface WatermarkSettings {
  logoEnabled?: boolean;
  logoUrl?: string;
  logoPosition?: string;
  logoOpacity?: number;
  tickerEnabled?: boolean;
  tickerText?: string;
  tickerSpeed?: number;
  tickerOpacity?: number;
  popEnabled?: boolean;
  popInterval?: number;
  popDuration?: number;
  popMode?: string;
  popOpacity?: number;
  popText?: string;
}

interface PlayerSettings {
  allowSpeed?: boolean;
  allowQuality?: boolean;
  allowFullscreen?: boolean;
  allowSkip?: boolean;
  allowBrightness?: boolean;
  resumeEnabled?: boolean;
  autoplayAllowed?: boolean;
  startTime?: number;
  endTime?: number;
  logoEnabled?: boolean;
  logoUrl?: string;
  logoPlacement?: string;
  logoSizePercent?: number;
  logoOpacity?: number;
  overlayEnabled?: boolean;
  overlayUrl?: string;
  overlayMode?: string;
  overlayOpacity?: number;
  qrEnabled?: boolean;
  qrUrl?: string;
  qrTitle?: string;
  qrDataUrl?: string;
  qrPlacement?: string;
  qrSizePercent?: number;
  qrOpacity?: number;
  qrBgEnabled?: boolean;
  qrBgOpacity?: number;
  showDisplayNames?: boolean;
  displayNameText?: string;
  displayNamePosition?: string;
  displayNameBgEnabled?: boolean;
  displayNameBgColor?: string;
  displayNameBgOpacity?: number;
  displayNameTextColor?: string;
  displayNameFontSize?: number;
  showHeadlines?: boolean;
  headlineText?: string;
  headlinePosition?: string;
  headlineBgEnabled?: boolean;
  headlineBgColor?: string;
  headlineBgOpacity?: number;
  headlineTextColor?: string;
  headlineFontSize?: number;
  fontFamily?: string;
  brandColor?: string;
}

interface PlayerBanner {
  id: string | number;
  text: string;
  type: string;
  position: string;
  speed?: number;
  backgroundColor?: string;
  textColor?: string;
  fontSize?: number;
  opacity?: number;
  paddingY?: number;
  paddingX?: number;
  enabled: boolean;
}


const POSITION_CLASSES: Record<string, string> = {
  "top-left": "top-3 left-3",
  "top-right": "top-3 right-3",
  "bottom-left": "bottom-12 left-3",
  "bottom-right": "bottom-12 right-3",
  "center": "top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
};

const POP_POSITIONS = ["top-3 left-3", "top-3 right-3", "bottom-12 left-3", "bottom-12 right-3", "top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"];

function resolveWatermarkText(template: string, videoId: string, sessionCode: string): string {
  const now = new Date().toLocaleTimeString();
  const domain = document.referrer ? new URL(document.referrer).hostname : window.location.hostname;
  return (template || "")
    .replace("{DOMAIN}", domain)
    .replace("{VIDEO_ID}", videoId)
    .replace("{SESSION_CODE}", sessionCode)
    .replace("{TIME}", now);
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function getClientInstanceId(): string {
  const KEY = "vcms:client-instance";
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return "fallback";
  }
}

export default function EmbedPlayerPage(props: any = {}) {
  const forcePublicId: string | undefined = props?.forcePublicId;
  const params = useParams<{ publicId: string }>();
  const publicId = forcePublicId || params.publicId;
  const search = useSearch();
  const urlParams = new URLSearchParams(search);
  // Capture the URL token ONCE at mount. wouter's useSearch updates on
  // replaceState, so re-deriving rawUrlToken every render would flip it to
  // empty as soon as the strip effect below cleans the address bar — and
  // because the init effect's deps include `token`, that would re-run init
  // with an empty token and abort playback. The ref freezes it.
  const initialUrlTokenRef = useRef<string | null>(null);
  if (initialUrlTokenRef.current === null) {
    initialUrlTokenRef.current = urlParams.get("token") || urlParams.get("embedToken") || "";
  }
  const rawUrlToken = initialUrlTokenRef.current;
  const isLmsHmacToken = rawUrlToken ? rawUrlToken.split(".").length === 2 : false;
  // Bootstrap token: memory-only token minted server-side from a short share link.
  // Allows /v/:publicId and /watch/:shareCode without exposing JWT in the URL.
  const bootstrapToken = getBootstrapToken();
  const urlToken = isLmsHmacToken ? "" : (rawUrlToken || bootstrapToken || "");

  // DEPRECATED: legacy ?token=JWT in URL — strip from the address bar after read
  // so the JWT never lives in browser history. Token stays in component state only.
  useEffect(() => {
    if (rawUrlToken && typeof window !== "undefined") {
      try {
        const clean = new URL(window.location.href);
        clean.searchParams.delete("token");
        clean.searchParams.delete("embedToken");
        window.history.replaceState({}, "", clean.pathname + (clean.search ? clean.search : "") + clean.hash);
      } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // URL-based start time: ?t=SECONDS takes priority over ?start=SECONDS
  const urlSeekTime = (() => {
    const raw = urlParams.get("t") || urlParams.get("start") || "";
    if (!raw) return -1;
    const n = parseFloat(raw);
    if (!isFinite(n) || n < 0 || n > 86400) return -1;
    return n;
  })();

  const activeTokenRef = useRef(urlToken);
  const token = urlToken;
  const receivedLmsTokenRef = useRef<string | null>(null);
  const lmsOriginsRef = useRef<string[]>([]);
  // Prevents cascading mints: once a session is active, ignore new LMS tokens until the session fails
  const lmsSessionActiveRef = useRef(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const progressIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const popIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const rotationIntervalRef = useRef<NodeJS.Timeout | null>(null);
  // P3: unified tick loop — replaces progress/heartbeat/ping intervals.
  const tickIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const tickCounterRef = useRef(0);
  const secondsWatchedRef = useRef(0);
  const sessionCodeRef = useRef<string | null>(null);
  const finalTickFiredRef = useRef(false);
  // Exposes the unified tick's "fire a final tick" callback so the pause/end
  // handlers (which live in a different useEffect) can trigger an analytics
  // flush via sendBeacon without re-creating their own copy of the loop.
  const fireFinalTickRef = useRef<(() => void) | null>(null);
  const controlsTimerRef = useRef<NodeJS.Timeout | null>(null);
  const devToolsCheckRef = useRef<NodeJS.Timeout | null>(null);
  const devToolsOpenRef = useRef(false);
  const streamSidRef = useRef("");
  const apiDurationRef = useRef(0);
  const denialSignalRef = useRef("");
  const lastPausedAtRef = useRef<number>(-1);
  const isRotatingRef = useRef(false);
  const rotationOpIdRef = useRef(0);
  // Circuit breaker — ONLY guards the fatal NETWORK_ERROR recovery path
  // (where hls.js has already exhausted its own retries and we'd otherwise
  // call startLoad() in an unbounded loop on a flapping upstream).
  // Non-fatal network errors and hls.js-internal canceled XHRs are NOT
  // counted here.
  // Resets to 0 on every FRAG_LOADED (proof playback is healthy).
  // Limit: 8 fatal-recovery restarts per 60s, with one final deferred retry
  // before declaring failure.
  const fatalRecoveryLogRef = useRef<number[]>([]);
  const deferredRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Rotation cool-down — once a session rotation completes successfully,
  // suppress further rotations for 60s. Without this, if the server keeps
  // emitting recoverable 403s, the player chains rotations every ~10s and
  // each one black-screens + restarts playback from the (briefly-zero)
  // savedTime captured during the previous rotation's MSE re-attach.
  const lastRotationAtRef = useRef<number>(0);
  const ROTATION_COOLDOWN_MS = 60_000;
  // ── STALL DETECTOR STATE ────────────────────────────────────────────
  const stallDetectorIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stallRecoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallLastTimeRef = useRef<number>(-1);
  const stallTicksRef = useRef<number>(0);
  const stallRecoveryLevelRef = useRef<number>(0); // 0=none 1=did-recoverMedia 2=did-nudge
  const isStallRecoveringRef = useRef<boolean>(false);
  // Last known good playback position, sampled continuously during healthy
  // playback. Used as savedTime when capturing currentTime at the moment
  // of a fatal error would return 0 (because hls.js or MSE has already
  // started tearing down the buffer).
  const lastHealthyTimeRef = useRef<number>(0);
  // Tracks the wall-clock time (ms) of the most recent intentional seek
  // (custom button, scrubber, native HTML5 controls, postMessage from LMS).
  // Used by the HLS error handler so a 403 that arrives shortly after a
  // seek triggers a lightweight local recovery (re-post progress + restart
  // load) instead of a full session rotation that would freeze the player
  // for 5-15s with a black screen.
  const lastSeekAtRef = useRef<number>(0);
  // Per-seek recovery budget — caps how many times we'll attempt the
  // lightweight recovery for a given seek burst. Resets every new seek.
  const seekRecoveryCountRef = useRef<number>(0);
  // Playback epoch — incremented on every intentional seek, replay-after-ended,
  // and session rotation. The progress interval attaches the current epoch to
  // each POST body; seeks abort the in-flight request and bump the epoch so
  // any response that does arrive on the wire is discarded by the server's
  // stale-advance guard (belt) and by AbortController cancellation (suspenders).
  const playbackEpochRef = useRef<number>(0);
  // AbortController for the currently in-flight periodic progress POST.
  // Aborting it on seek prevents the old-position request from reaching the
  // server (or at minimum cancels response processing on the client side).
  const progressAbortRef = useRef<AbortController | null>(null);
  // ── SEEK GUARD ──────────────────────────────────────────────────────
  // True from the moment any seek begins (user scrubber, skip button,
  // postMessage, native HTML5 seek) until the video element fires the
  // `seeked` / `playing` event OR a 1s safety timer expires. While true:
  //   • the 10-second periodic progress interval skips its tick (so the
  //     intermediate / pre-seek currentTime is never reported)
  //   • the native `onNativeSeeking` handler bails out (the in-flight
  //     `seekProgressWithTimeout` already covers it — no duplicate POST)
  // Fixes the duplicated alternating progress reports the user observed
  // (e.g. "idx 5, idx 41, idx 5, idx 41" within a single second after a
  // backward seek).
  const isSeekingRef = useRef<boolean>(false);
  // Debug logger guarded by an env flag so production stays silent.
  // Enable in dev or by setting `VITE_SECURE_PLAYER_DEBUG=true`.
  const SECURE_PLAYER_DEBUG = (import.meta as any).env?.VITE_SECURE_PLAYER_DEBUG === "true" || (import.meta as any).env?.DEV === true;
  const sdbg = (...args: any[]) => { if (SECURE_PLAYER_DEBUG) console.debug("[player]", ...args); };
  // ── MOUNT IDENTITY ──────────────────────────────────────────────────
  // Random per-mount id used in every debug log line. If two players are
  // mounted (e.g. duplicate iframe, double-included on LMS page) the same
  // backend SID will receive POSTs tagged with two different mountIds.
  // Mount/unmount lifecycle is logged so the user can see if the same
  // EmbedPlayer was mounted twice from a single render tree.
  const mountIdRef = useRef<string>("");
  if (!mountIdRef.current) {
    mountIdRef.current = (typeof crypto !== "undefined" && (crypto as any).randomUUID)
      ? (crypto as any).randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  }
  // ── CENTRAL PROGRESS DISPATCH ───────────────────────────────────────
  // EVERY POST to /api/stream/:publicId/progress MUST go through here.
  // No other call-site is allowed to issue the request directly. This
  // guarantees one chokepoint for: dedup window, same-segment suppression,
  // stale-zero guard, epoch staleness check, seek-guard skip, abort, and
  // debug logging. Returns the fetch Promise (resolved void) so callers
  // that need to await (e.g. the pre-seek post) can chain a timeout race.
  const SEGMENT_DURATION_SEC = 2;
  const PROGRESS_DEDUP_WINDOW_MS = 800;
  const lastProgressSentAtRef = useRef<number>(0);
  const lastSentSegmentIdxRef = useRef<number>(-1);
  type ProgressReason =
    | "interval"        // 10s periodic loop
    | "seek"            // user-initiated seek (scrubber / skip / postMessage / native)
    | "rotation"        // rotate-session re-anchor after MANIFEST_PARSED / safetyTimer
    | "refresh"         // refresh-token re-anchor (brand-new session)
    | "seek-recovery"   // 403-after-seek lightweight recovery
    | "pause-resume"    // long-pause rotation re-anchor
    | "manual";         // reportProgressNow caller
  interface SendProgressOpts {
    seekTo?: boolean;
    sid?: string;
    epoch?: number;
    signal?: AbortSignal;
  }
  const sendProgress = (reason: ProgressReason, currentTime: number, opts?: SendProgressOpts): Promise<void> => {
    if (!publicId) return Promise.resolve();
    const sid = opts?.sid ?? streamSidRef.current;
    if (!sid) { sdbg("sendProgress skip — no sid", { reason }); return Promise.resolve(); }
    const epoch = opts?.epoch ?? playbackEpochRef.current;
    const mountId = mountIdRef.current;
    const isAuthoritative = reason === "seek" || reason === "rotation" || reason === "refresh" || reason === "seek-recovery" || reason === "pause-resume";

    // 1. Interval ticks must yield to active seeks. The seek POST has
    //    already published the authoritative new currentTime; an interval
    //    tick at this moment would either read a transitional value or
    //    the OLD position pre-seek.
    if (reason === "interval" && isSeekingRef.current) {
      sdbg("sendProgress skip — interval while seeking", { mountId });
      return Promise.resolve();
    }
    // 2. Interval ticks must skip while a session rotation is in-flight
    //    (MSE is being flushed; v.currentTime can transiently read 0).
    if (reason === "interval" && isRotatingRef.current) {
      sdbg("sendProgress skip — interval while rotating", { mountId });
      return Promise.resolve();
    }
    // 3. STALE-ZERO GUARD. If a non-authoritative caller (interval /
    //    manual / heartbeat) passes currentTime≈0 while the video
    //    element is actually positioned well past zero, that POST would
    //    reset the server's sliding window to [0, windowSegs] and
    //    produce the "alternating idx 22 / idx 0" pattern the user
    //    reported. Drop it.
    //    SCOPING: only applied to NON-authoritative reasons. The seek /
    //    rotation / refresh / pause-resume paths POST progress BEFORE
    //    setting v.currentTime to the new target, so at the moment a
    //    legitimate seek-to-0 (e.g. replay-from-end) fires, the video
    //    element still reads the OLD high currentTime. Blocking those
    //    would silently break replay-from-end. The authoritative
    //    re-anchor handlers protect themselves by always passing a
    //    sensible `resumeAt` (pendingMessageSeekRef ?? savedTime), and
    //    the dedup / same-segment guards still keep them honest.
    if (!isAuthoritative) {
      const v = videoRef.current;
      if (currentTime < 0.5 && v && v.currentTime > 1) {
        sdbg("sendProgress BLOCK — stale zero (non-authoritative)", { reason, passed: currentTime, real: v.currentTime, mountId });
        return Promise.resolve();
      }
    }
    // 4. Dedup window for non-seek reasons. Two POSTs within 800ms are
    //    almost certainly the same gesture being double-reported.
    const now = Date.now();
    if (!isAuthoritative && now - lastProgressSentAtRef.current < PROGRESS_DEDUP_WINDOW_MS) {
      sdbg("sendProgress skip — dedup window", { reason, sinceLastMs: now - lastProgressSentAtRef.current, mountId });
      return Promise.resolve();
    }
    // 5. Same-segment dedup for interval ticks. The server's sliding
    //    window only advances at segment boundaries, so two interval
    //    ticks reporting the same segment idx are pure noise.
    const segIdx = Math.floor(Math.max(0, currentTime) / SEGMENT_DURATION_SEC);
    if (reason === "interval" && segIdx === lastSentSegmentIdxRef.current) {
      sdbg("sendProgress skip — same segment", { reason, segIdx, mountId });
      return Promise.resolve();
    }
    // 6. Epoch staleness for non-authoritative sends. Authoritative
    //    sends carry their own epoch by design and must always go out.
    if (!isAuthoritative && epoch !== playbackEpochRef.current) {
      sdbg("sendProgress skip — stale epoch", { reason, capturedEpoch: epoch, current: playbackEpochRef.current, mountId });
      return Promise.resolve();
    }

    lastProgressSentAtRef.current = now;
    lastSentSegmentIdxRef.current = segIdx;
    const body: any = { sid, currentTime, epoch, reason, mountId };
    if (opts?.seekTo) body.seekTo = true;
    sdbg("sendProgress →", { reason, currentTime: Number(currentTime.toFixed(2)), segIdx, epoch, mountId });

    return fetch(`/api/stream/${publicId}/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: opts?.signal,
    }).then(() => undefined).catch(() => undefined);
  };
  // Set to true when the video element fires "ended". Cleared whenever a seek
  // or replay resets the position. Prevents the progress interval from
  // sending the end-of-video position after playback finishes, which would
  // leave a stale high-index window that freezes replay from the beginning.
  const videoEndedRef = useRef<boolean>(false);
  // Bounded wait for the pre-seek /progress POST. If the request stalls
  // (proxy hang, dropped TCP), we MUST still resume loading at the new
  // position — otherwise stopLoad() runs, the POST never settles, and
  // startLoad() is never called → permanent buffering overlay. The
  // server's seek-grace window will still accept slightly-stale state.
  const SEEK_PROGRESS_TIMEOUT_MS = 700;
  const seekProgressWithTimeout = (sid: string, currentTime: number): Promise<void> => {
    if (!publicId) return Promise.resolve();
    // Cancel any in-flight periodic progress POST from the OLD position before
    // it reaches the server. If the request is already in-flight at the TCP
    // level this abort won't stop the server from processing it, but the
    // server-side stale-advance guard (SEEK_STALE_GUARD_MS) catches those.
    if (progressAbortRef.current) {
      try { progressAbortRef.current.abort(); } catch {}
      progressAbortRef.current = null;
    }
    // Bump playback epoch so any concurrent interval tick that spawns a new
    // request after this point carries the new epoch in its body, and the
    // periodic interval's capture-and-recheck pattern drops stale sends.
    playbackEpochRef.current += 1;
    const epoch = playbackEpochRef.current;
    sdbg("seek epoch incremented", { epoch, currentTime });
    // Seeking always clears the ended flag — we are now at a new position.
    videoEndedRef.current = false;
    // Raise the seek guard so the periodic progress interval and the
    // native `seeking` listener both skip until playback resumes.
    isSeekingRef.current = true;
    const v = videoRef.current;
    const clearGuard = () => {
      if (!isSeekingRef.current) return;
      isSeekingRef.current = false;
      try { v?.removeEventListener("seeked", clearGuard); } catch {}
      try { v?.removeEventListener("playing", clearGuard); } catch {}
      clearTimeout(guardTimer);
      sdbg("seek guard cleared");
    };
    if (v) {
      v.addEventListener("seeked", clearGuard, { once: true });
      v.addEventListener("playing", clearGuard, { once: true });
    }
    // Safety fallback — `seeked`/`playing` can be deferred or skipped under
    // network stall. Hard-clear after 1s so the periodic loop resumes.
    const guardTimer = setTimeout(clearGuard, 1000);
    const req = sendProgress("seek", currentTime, { sid, epoch, seekTo: true });
    return Promise.race([
      req,
      new Promise<void>(resolve => setTimeout(resolve, SEEK_PROGRESS_TIMEOUT_MS)),
    ]);
  };
  const guardedFatalRestart = (hls: any) => {
    const now = Date.now();
    fatalRecoveryLogRef.current = fatalRecoveryLogRef.current.filter(t => t > now - 60_000);
    if (fatalRecoveryLogRef.current.length >= 8) {
      // Budget exhausted — schedule ONE final deferred retry after 5s.
      // If it also fails (next fatal arrives), THEN we show the error.
      if (deferredRetryTimerRef.current) return false; // already pending fatal
      if (import.meta.env.DEV) console.warn("[player] fatal-recovery budget exhausted — deferring final retry");
      deferredRetryTimerRef.current = setTimeout(() => {
        deferredRetryTimerRef.current = null;
        fatalRecoveryLogRef.current = []; // give the deferred retry a clean budget
        try { hls.startLoad(); } catch {}
      }, 5000);
      return true; // suppress the user-facing error for now
    }
    fatalRecoveryLogRef.current.push(now);
    hls.startLoad();
    return true;
  };
  const effectiveSecurityRef = useRef<Record<string, any>>({ blockDevTools: true });
  // Hardening hints from manifest endpoint: { intervalSec, v2, msGuard }
  const hardeningHintRef = useRef<{ intervalSec: number; v2: boolean; msGuard: boolean }>({ intervalSec: 180, v2: false, msGuard: false });
  // Heartbeat v2 monotonic seq
  const heartbeatSeqRef = useRef(0);
  const msGuardCleanupRef = useRef<(() => void) | null>(null);

  // Control bridge refs
  const playerReadyRef = useRef(false);
  const pendingInitialSeekRef = useRef<number>(urlSeekTime);
  const pendingMessageSeekRef = useRef<number | null>(null);
  // STARTUP RESUME-CLOBBER GUARD state.
  // initialResumeTargetRef holds the saved-position resume target (seconds)
  // that we are seeking to but have NOT yet reached via playback. While it is
  // > 0, HLS.js can synthesize a native `seeking` event that snaps currentTime
  // back toward 0 (buffer not yet appended at the resume offset). That event is
  // NOT a user seek — onNativeSeeking ignores a snap-to-start during this
  // window so it never POSTs seekTo:true with currentTime≈0 (which would reset
  // the server window to 0 and restart the video — the 322→0 jump in the logs).
  const initialResumeTargetRef = useRef<number>(-1);
  const initialResumeSetAtRef = useRef<number>(0);
  const resumeReassertCountRef = useRef<number>(0);
  // Active target of an in-flight performLocalSeek. Used by the 1.5s
  // self-retry watchdog so a stale retry from an earlier seek can't
  // clobber a newer seek the user has since issued.
  const pendingSeekTargetRef = useRef<number | null>(null);
  const parentOriginRef = useRef<string>("");
  const seekOpIdRef = useRef(0);
  const isSeeking = useRef(false);
  const seekResumeRef = useRef(false);

  const [status, setStatus] = useState<"waiting" | "blocked" | "loading" | "ready" | "error" | "unavailable" | "processing">(
    urlToken || isLmsHmacToken ? "loading" : "waiting"
  );
  // Inline buffering state shown over the playing video (YouTube/Netflix-style
  // spinner). Distinct from `status === "loading"` which is the *initial*
  // pre-ready load. isBuffering flips true while hls.js is filling buffers
  // mid-playback (seek targets, network stalls, post-rotation re-buffer).
  const [isBuffering, setIsBuffering] = useState(false);
  const [bufferPct, setBufferPct] = useState(0);
  // Absolute buffered-end position as % of total duration — drives the
  // YouTube-style light buffer bar on the seek track.
  const [bufferedEndPct, setBufferedEndPct] = useState(0);
  // Failsafe: auto-clear the buffering overlay if no `playing`/`canplay`
  // event arrives within 15s after we flipped it true. Prevents a stuck
  // spinner in pathological stalls where playback events never fire but
  // the recovery ladder is still trying. The user can always see actual
  // failures via the `error` status overlay.
  const bufferingFailsafeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (bufferingFailsafeRef.current) {
      clearTimeout(bufferingFailsafeRef.current);
      bufferingFailsafeRef.current = null;
    }
    if (!isBuffering) return;
    bufferingFailsafeRef.current = setTimeout(() => {
      setIsBuffering(false);
    }, 15000);
    return () => {
      if (bufferingFailsafeRef.current) {
        clearTimeout(bufferingFailsafeRef.current);
        bufferingFailsafeRef.current = null;
      }
    };
  }, [isBuffering]);
  const [errorMsg, setErrorMsg] = useState("");
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [brightness, setBrightness] = useState(100);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showControls, setShowControls] = useState(true);
  const [qualities, setQualities] = useState<{ height: number; index: number }[]>([]);
  const [currentQuality, setCurrentQuality] = useState(-1);
  const [sessionCode, setSessionCode] = useState("");
  const [secondsWatched, setSecondsWatched] = useState(0);
  const [popVisible, setPopVisible] = useState(false);
  const [popPosition, setPopPosition] = useState("top-3 right-3");
  const [playerSettings, setPlayerSettings] = useState<PlayerSettings>({});
  const [watermarkSettings, setWatermarkSettings] = useState<WatermarkSettings>({});
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [videoId, setVideoId] = useState("");
  const [effectiveSecurity, setEffectiveSecurity] = useState<Record<string, any>>({ blockDevTools: true });
  const [isAdminPreview, setIsAdminPreview] = useState(false);
  const [securityReady, setSecurityReady] = useState(false);

  // Violation counter — loaded from localStorage so it persists across refreshes
  // Disabled only for admin preview or before security settings are loaded.
  // suspiciousDetectionEnabled controls server-side rate-limiting, NOT client-side
  // violation events (DevTools, right-click, focus mode, etc.).
  const { reportViolation, isBlocked, remainingMs, toast: violationToast } =
    useSecurityViolations(videoId, effectiveSecurity, {
      disabled: isAdminPreview || !securityReady,
      sessionKey: sessionCode || undefined,
    });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [tickerOffset, setTickerOffset] = useState(0);
  const [playbackDenied, setPlaybackDenied] = useState(false);
  const [denialSignal, setDenialSignal] = useState<string>("");
  const [retryKey, setRetryKey] = useState(0);

  // Session limit state — when userId concurrent limit is reached
  const [sessionLimitInfo, setSessionLimitInfo] = useState<{ activeSessions: any[] } | null>(null);
  const [playerBanners, setPlayerBanners] = useState<PlayerBanner[]>([]);
  const [bannerTickerOffsets, setBannerTickerOffsets] = useState<Record<string | number, number>>({});

  // Keep refs in sync so closures inside HLS error handlers always read latest values
  useEffect(() => { denialSignalRef.current = denialSignal; }, [denialSignal]);
  useEffect(() => { effectiveSecurityRef.current = effectiveSecurity; }, [effectiveSecurity]);

  const triggerDenial = (signal: string) => {
    if (effectiveSecurityRef.current?.suspiciousDetectionEnabled === false && signal !== "devtools") return;
    denialSignalRef.current = signal;
    setDenialSignal(signal);
    setPlaybackDenied(true);
  };

  const retryPlayback = () => {
    setPlaybackDenied(false);
    setDenialSignal("");
    denialSignalRef.current = "";
    lmsSessionActiveRef.current = false; // allow fresh LMS token on retry
    hlsRef.current?.destroy();
    hlsRef.current = null;
    setStatus("loading");
    setRetryKey(k => k + 1);
  };

  // Post a message to the parent frame using the validated origin (never wildcard if known)
  const postToParent = (msg: Record<string, any>) => {
    if (window.parent === window) return;
    const origin = parentOriginRef.current || "*";
    try { window.parent.postMessage(msg, origin); } catch {}
  };

  // Apply the highest-priority pending seek once the player is ready
  const applyPendingSeek = (overrideTime?: number) => {
    const video = videoRef.current;
    if (!video) return;

    // During a token/session rotation the HLS source is being swapped — queue
    // the seek so it is applied after the rotation completes instead of being
    // overwritten by the rotation restore logic.
    if (isRotatingRef.current) {
      const t = overrideTime !== undefined ? overrideTime
        : pendingMessageSeekRef.current !== null ? pendingMessageSeekRef.current
        : pendingInitialSeekRef.current;
      if (t >= 0) pendingMessageSeekRef.current = t;
      return;
    }

    // Identify the seek source BEFORE the pending refs are cleared below.
    //   override → user/parent-driven (performLocalSeek-to-start, SEEK message)
    //   message  → queued postMessage seek
    //   initial  → the startup saved-position resume (MANIFEST_PARSED path)
    const seekSource: "override" | "message" | "initial" =
      overrideTime !== undefined ? "override"
        : pendingMessageSeekRef.current !== null ? "message"
          : "initial";
    const seekTime = overrideTime !== undefined
      ? overrideTime
      : pendingMessageSeekRef.current !== null
        ? pendingMessageSeekRef.current
        : pendingInitialSeekRef.current;
    // Allow seeking to 0 (start of video); only reject genuinely invalid times
    if (seekTime < 0) return;
    const dur = video.duration;
    const clampedTime = isFinite(dur) && dur > 0
      ? Math.max(0, Math.min(seekTime, dur - 0.5))
      : Math.max(0, seekTime);
    pendingInitialSeekRef.current = -1;
    pendingMessageSeekRef.current = null;
    // Arm the startup resume-clobber guard only for a genuine initial resume to
    // a meaningful offset. Any user/parent-driven seek supersedes (disarms) it.
    if (seekSource === "initial" && clampedTime > 10) {
      initialResumeTargetRef.current = clampedTime;
      initialResumeSetAtRef.current = Date.now();
      resumeReassertCountRef.current = 0;
    } else if (seekSource !== "initial") {
      initialResumeTargetRef.current = -1;
    }
    if (import.meta.env.DEV) console.debug("[EmbedControl] applied seek", clampedTime);

    // Each seek gets a unique operation ID so rapid sequential seeks cancel
    // stale listeners from earlier calls instead of firing duplicate events.
    const opId = ++seekOpIdRef.current;

    // Latch the "was playing" intent from the FIRST seek in a burst.
    // If seek #1 pauses the video and seek #2 arrives before #1 finishes,
    // seek #2 would see video.paused=true and never resume. The latch
    // preserves the original intent across rapid sequential seeks.
    if (!isSeeking.current) {
      seekResumeRef.current = !video.paused;
    }

    // Mark the seek as in-progress so internal video.pause() calls from this
    // function do NOT trigger a spurious PAUSE postMessage to the parent.
    isSeeking.current = true;

    // Fire SEEKED only after the video element has actually completed the seek
    // AND the decoded frame at the target position has been painted to screen.
    let fallbackTimer: ReturnType<typeof setTimeout>;

    const finishSeek = () => {
      if (opId !== seekOpIdRef.current) return;
      isSeeking.current = false;
      const shouldResume = seekResumeRef.current;
      seekResumeRef.current = false;
      const actual = videoRef.current?.currentTime ?? clampedTime;
      postToParent({ type: "SEEKED", time: actual });
      if (shouldResume) videoRef.current?.play().catch(() => {});
    };

    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      clearTimeout(fallbackTimer);
      if (opId !== seekOpIdRef.current) return;
      // Double rAF guarantees the frame is painted before we report back
      requestAnimationFrame(() => {
        requestAnimationFrame(() => finishSeek());
      });
    };

    // Safety fallback: if seeked never fires (e.g. severe network stall),
    // report the current position and restore playback so the player isn't
    // left frozen.
    fallbackTimer = setTimeout(() => {
      video.removeEventListener("seeked", onSeeked);
      finishSeek();
    }, 5000);

    video.addEventListener("seeked", onSeeked);

    // Robust HLS.js seek sequence:
    // 1. Pause so HLS isn't mid-fragment-download when we change position
    // 2. stopLoad() so HLS cancels any in-flight requests
    // 3. Set currentTime to the target
    // 4. startLoad(targetTime) so HLS fetches segments from the right place
    // Playback is restored inside finishSeek once the frame is confirmed visible.
    const hls = hlsRef.current;
    if (hls) {
      // Show buffering overlay immediately so the user sees feedback even if
      // the seek takes a moment to flush + re-buffer.
      setIsBuffering(true);
      setBufferPct(0);

      // PROACTIVE WINDOW ADVANCE — AWAIT the progress POST so the server
      // moves its sliding window BEFORE we restart segment loading. Without
      // the await, hls.startLoad(target) raced the POST and chunk requests
      // arrived at the server while it still expected the OLD position,
      // producing a cascade of 403s + a 30-45s retry-storm freeze.
      const currentSid = streamSidRef.current;
      lastSeekAtRef.current = Date.now();
      seekRecoveryCountRef.current = 0;
      video.pause();
      hls.stopLoad();
      const finishHlsSeek = () => {
        video.currentTime = clampedTime;
        hls.startLoad(clampedTime);
      };
      // Bounded wait — guarantees startLoad runs even if POST stalls.
      const seekPromise = currentSid
        ? seekProgressWithTimeout(currentSid, clampedTime)
        : Promise.resolve();
      seekPromise.then(finishHlsSeek, finishHlsSeek);
    } else {
      // Native HLS (Safari) — browser handles seeking on its own
      video.currentTime = clampedTime;
    }
  };

  useEffect(() => {
    if (
      effectiveSecurity?.suspiciousDetectionEnabled === false &&
      playbackDenied &&
      denialSignal !== "devtools"
    ) {
      setPlaybackDenied(false);
      setDenialSignal("");
      denialSignalRef.current = "";
    }
  }, [effectiveSecurity?.suspiciousDetectionEnabled]);

  // Iframe-only enforcement + postMessage receiver for LMS launch tokens
  useEffect(() => {
    if (urlToken) return; // admin preview / static embed token in URL — skip iframe enforcement

    // If HMAC token was in URL (Query Param mode from LMS), inject it directly
    if (isLmsHmacToken && rawUrlToken && !lmsSessionActiveRef.current) {
      lmsSessionActiveRef.current = true;
      receivedLmsTokenRef.current = rawUrlToken;
      setStatus("loading");
      setRetryKey(k => k + 1);
      return;
    }

    // Block if opened as a top-level page (not embedded in an iframe)
    if (window.top === window.self) {
      setStatus("blocked");
      return;
    }

    // Fetch the list of allowed LMS origins from the server
    fetch("/api/lms/origins")
      .then(r => r.json())
      .then(data => { lmsOriginsRef.current = data.origins || []; })
      .catch(() => {});

    // Listen for the LMS launch token via postMessage
    const handler = (event: MessageEvent) => {
      if (!lmsOriginsRef.current.includes(event.origin)) return;
      const msg = event.data;
      if (!msg || msg.type !== "LMS_LAUNCH_TOKEN" || typeof msg.token !== "string") return;
      if (lmsSessionActiveRef.current) return;
      lmsSessionActiveRef.current = true;
      receivedLmsTokenRef.current = msg.token;
      setStatus("loading");
      setRetryKey(k => k + 1);
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicId, urlToken, isLmsHmacToken, rawUrlToken]);

  // Control bridge — postMessage API for parent LMS to seek/play/pause the player
  useEffect(() => {
    // Fetch allowed LMS origins if not already loaded (e.g. when urlToken path skipped it)
    if (lmsOriginsRef.current.length === 0 && window.parent !== window) {
      fetch("/api/lms/origins")
        .then(r => r.json())
        .then(data => { lmsOriginsRef.current = data.origins || []; })
        .catch(() => {});
    }

    const controlHandler = (event: MessageEvent) => {
      // Validate origin against the allowed LMS list OR against a known parent origin
      const knownOrigin = parentOriginRef.current;
      const isAllowed =
        (lmsOriginsRef.current.length > 0 && lmsOriginsRef.current.includes(event.origin)) ||
        (knownOrigin && event.origin === knownOrigin);

      if (!isAllowed) {
        if (import.meta.env.DEV) console.debug("[EmbedControl] blocked message from origin", event.origin);
        return;
      }

      // Capture/refresh the validated parent origin for postToParent responses
      if (event.origin && event.origin !== "null") {
        parentOriginRef.current = event.origin;
      }

      const msg = event.data;
      if (!msg || typeof msg.type !== "string") return;

      if (import.meta.env.DEV) console.debug("[EmbedControl] received", msg.type, "from", event.origin);

      switch (msg.type) {
        case "SEEK_TO": {
          const t = typeof msg.time === "number" ? msg.time : parseFloat(msg.time);
          if (!isFinite(t) || t < 0) return;
          if (playerReadyRef.current) {
            applyPendingSeek(t);
          } else {
            pendingMessageSeekRef.current = t;
            if (import.meta.env.DEV) console.debug("[EmbedControl] stored pending seek", t);
          }
          break;
        }
        case "PLAY": {
          if (playerReadyRef.current) {
            videoRef.current?.play().catch(() => {});
          }
          break;
        }
        case "PAUSE": {
          videoRef.current?.pause();
          break;
        }
        case "GET_CURRENT_TIME": {
          postToParent({ type: "CURRENT_TIME", time: videoRef.current?.currentTime ?? 0 });
          break;
        }
        default:
          break;
      }
    };

    window.addEventListener("message", controlHandler);
    return () => window.removeEventListener("message", controlHandler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicId]);

  // Initialize player
  useEffect(() => {
    const init = async () => {
      // If no URL token and no LMS token received yet, do not proceed
      if (!urlToken && !receivedLmsTokenRef.current) return;

      try {
        // Secure token minting: if no explicit URL token, mint using the LMS launch token received via postMessage
        let activeToken = token;
        if (!token) {
          const mintBody: Record<string, string> = {};
          const lmsToken = receivedLmsTokenRef.current;
          if (lmsToken) mintBody.lmsLaunchToken = lmsToken;

          const mintRes = await fetch(`/api/player/${publicId}/mint`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-client-instance": getClientInstanceId() },
            credentials: "include",
            body: JSON.stringify(mintBody),
          });
          if (mintRes.status === 429) {
            const d = await mintRes.json().catch(() => ({}));
            if (d.code === "SESSION_LIMIT") {
              lmsSessionActiveRef.current = false;
              setSessionLimitInfo({ activeSessions: d.activeSessions || [] });
              setStatus("error");
              setErrorMsg("SESSION_LIMIT");
              return;
            }
          }
          if (!mintRes.ok) {
            const d = await mintRes.json().catch(() => ({}));
            lmsSessionActiveRef.current = false; // unlock so next LMS token can retry
            setStatus("error");
            setErrorMsg(d.message || "Could not start session");
            return;
          }
          const mintData = await mintRes.json();
          activeToken = mintData.token;
          activeTokenRef.current = activeToken;
        }

        // Fetch manifest
        const referrer = document.referrer;
        const fetchManifest = (tok: string) => fetch(
          `/api/player/${publicId}/manifest${tok ? `?token=${encodeURIComponent(tok)}` : ""}`,
          { headers: referrer ? { "x-embed-referrer": referrer } : {} },
        );

        let manifestRes = await fetchManifest(activeToken);

        // SILENT 401 RECOVERY: the embed JWT in the iframe URL has a short TTL
        // (EMBED_TOKEN_TTL, ~5 min) but the iframe/session can outlive it —
        // especially in the LMS API channel under load. Rather than immediately
        // showing "Access Link Expired", ask the server to mint a fresh token
        // off the (expired-but-signed) one and retry the manifest exactly once.
        // Only if THIS also fails do we fall through to the error screen below.
        if (manifestRes.status === 401 && activeToken) {
          let isAdminPreviewTok = false;
          try {
            const parts = activeToken.split(".");
            if (parts.length === 3) {
              const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
              isAdminPreviewTok = payload?.adminPreview === true;
            }
          } catch {}
          if (!isAdminPreviewTok) {
            try {
              const rr = await fetch(`/api/player/${publicId}/refresh-token`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: activeToken }),
              });
              if (rr.ok) {
                const rd = await rr.json();
                if (rd.token) {
                  activeToken = rd.token;
                  activeTokenRef.current = rd.token;
                  manifestRes = await fetchManifest(activeToken);
                }
              }
            } catch {}
          }
        }

        if (manifestRes.status === 202) {
          setStatus("processing");
          return;
        }

        if (!manifestRes.ok) {
          const data = await manifestRes.json().catch(() => ({}));
          if (manifestRes.status === 503) { setStatus("unavailable"); return; }
          if (manifestRes.status === 403) { setStatus("unavailable"); setErrorMsg(data.message || "Access denied"); return; }
          if (manifestRes.status === 401 && token) {
            let isAdminPreviewToken = false;
            try {
              const parts = token.split(".");
              if (parts.length === 3) {
                const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
                isAdminPreviewToken = payload?.adminPreview === true;
              }
            } catch {}
            setStatus("error");
            setErrorMsg(isAdminPreviewToken ? "PREVIEW_TOKEN_EXPIRED" : "SHARE_TOKEN_EXPIRED");
            return;
          }
          if (manifestRes.status === 409 && data.code === "HLS_NOT_AVAILABLE") {
            setStatus("error");
            setErrorMsg("HLS not available — this video has not been converted for our custom player yet. An admin needs to build the HLS from the video source.");
            return;
          }
          if (manifestRes.status === 409 && data.code === "VIDEO_NOT_SECURE_REBUILD_REQUIRED") {
            setStatus("error");
            setErrorMsg("This video requires encrypted HLS to play. An admin needs to rebuild the HLS from the video settings.");
            return;
          }
          setStatus("error");
          setErrorMsg(data.message || "Failed to load video");
          return;
        }

        const data = await manifestRes.json();
        // Session is now established — lock out further LMS postMessage tokens to prevent cascade revocations
        if (!urlToken) lmsSessionActiveRef.current = true;
        const resolvedVideoId = data.videoId || "";
        setVideoId(resolvedVideoId);
        if (data.adminPreview === true) setIsAdminPreview(true);
        if (data.videoDuration && data.videoDuration > 0) { apiDurationRef.current = data.videoDuration; setDuration(data.videoDuration); }

        // Fetch video settings and effective security in parallel
        const qs = activeToken ? `?token=${encodeURIComponent(activeToken)}` : "";
        await Promise.allSettled([
          fetch(`/api/player/${publicId}/settings${qs}`).then(async r => {
            if (r.ok) {
              const s = await r.json();
              setPlayerSettings(s.playerSettings || {});
              setWatermarkSettings(s.watermarkSettings || {});
              if (s.thumbnailUrl) setThumbnailUrl(s.thumbnailUrl);
              if (s.videoDuration && s.videoDuration > 0) { apiDurationRef.current = s.videoDuration; setDuration(s.videoDuration); }
              const activeBanners = (s.banners || []).filter((b: PlayerBanner) => b.enabled);
              setPlayerBanners(activeBanners);
              const initOffsets: Record<string | number, number> = {};
              activeBanners.forEach((b: PlayerBanner) => { initOffsets[b.id] = 0; });
              setBannerTickerOffsets(initOffsets);
            }
          }),
          resolvedVideoId
            ? fetch(`/api/security/effective/${resolvedVideoId}`).then(async r => {
                if (r.ok) {
                  const secData = await r.json();
                  setEffectiveSecurity(secData);
                }
                setSecurityReady(true);
              }).catch(() => { setSecurityReady(true); })
            : Promise.resolve().then(() => { setSecurityReady(true); }),
        ]);

        // P3: session ping is now folded into the unified /tick loop —
        // the first tick (n=1) forces include=["progress","ping"] which
        // mints the sessionCode server-side and returns it in the response.
        // We no longer fire a separate /ping at init, which removes one
        // Railway round-trip from the player startup path.

        // Stealth Protected Playback Mode: when enabled, the server returns
        // an opaque stream URL (/api/player/:publicId/stream/window/<opaqueId>)
        // that hides .m3u8 / .ts / /key / master / index / seg_* from the
        // Network tab. Hls.js treats it as a single-bitrate level playlist.
        // Stealth uses application/octet-stream — only safe for hls.js MSE path.
        // Safari/iOS native HLS requires application/vnd.apple.mpegurl, so fall
        // back to the legacy /hls/ manifestUrl on the native branch.
        const stealthEnabled = !!(data.stealth && data.stealth.enabled && data.stealth.streamUrl) && Hls.isSupported();
        const manifestUrl = stealthEnabled ? data.stealth.streamUrl : data.manifestUrl;
        if (!manifestUrl) { setStatus("error"); setErrorMsg("No manifest URL"); return; }
        if (stealthEnabled && import.meta.env.DEV) console.debug("[Stealth] using opaque stream URL");
        if (data.sessionId) streamSidRef.current = data.sessionId;
        if (data.heartbeat && typeof data.heartbeat === "object") {
          hardeningHintRef.current = {
            intervalSec: Number(data.heartbeat.intervalSec) || 180,
            v2: !!data.heartbeat.v2,
            msGuard: !!data.heartbeat.msGuard,
          };
          if (hardeningHintRef.current.msGuard && !msGuardCleanupRef.current && publicId) {
            msGuardCleanupRef.current = installMediaSourceGuard({
              publicId,
              getSid: () => streamSidRef.current,
              enabled: true,
            });
          }
        }

        if (!videoRef.current) return;
        const video = videoRef.current;

        if (Hls.isSupported()) {
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            // Prevent HLS.js from auto-starting segment loads on MANIFEST_PARSED.
            // Rotation handlers call hls.startLoad(resumeAt) explicitly so that
            // call is the ONLY startLoad and is always honoured. Without this,
            // HLS.js's internal handler fires first, starts loading from seg 0,
            // and our stopLoad()+startLoad(resumeAt) races/loses.
            autoStartLoad: false,

            // ── BUFFER (YouTube-style aggressive pre-load) ─────────────
            // Buffer up to 60s ahead. When internet is good the player
            // silently fills this window; on slowdown it plays from the
            // pre-filled buffer without stalling.
            maxBufferLength: 60,
            maxMaxBufferLength: 120,
            backBufferLength: 30,
            // Pre-fetch the first fragment before media is attached so the
            // very first frame appears faster (reduces initial black screen).
            startFragPrefetch: true,

            // ── ABR / QUALITY SELECTION ────────────────────────────────
            // Start at the level that best matches the current estimated
            // bandwidth (-1 = auto). A conservative initial bandwidth
            // estimate (500 kbps) means hls.js starts at a low/mid quality
            // and works UP rather than starting at 720p and aborting — that
            // abort-then-retry pattern is what causes the cancel storms in
            // the network tab.
            startLevel: -1,
            abrEwmaDefaultEstimate: 500000,
            // Only use 70% of measured bandwidth for quality decisions
            // (headroom for RTT jitter and Railway origin latency).
            abrBandwidthFactor: 0.7,
            // Be slow to upgrade quality (50% of bandwidth needed before
            // stepping up) — prevents thrashing on variable connections.
            abrBandwidthUpFactor: 0.5,
            // Never request a quality level higher than the player can
            // actually display — saves bandwidth on small-screen embeds.
            capLevelToPlayerSize: true,
            // Use real measured bitrate rather than just manifest bitrate
            // for ABR decisions.
            abrMaxWithRealBitrate: true,

            // ── RETRIES ────────────────────────────────────────────────
            // Retry counts reduced from 4 → 2 to prevent client-side retry
            // storms. With 4 retries × ~6 prefetched fragments × cascading
            // failures, a single transient error could create 20+ doomed
            // requests in a couple of seconds. Two retries is enough for
            // genuine transient errors; our token-rotation recovery path
            // handles the rest.
            manifestLoadingMaxRetry: 2,
            manifestLoadingRetryDelay: 1500,
            levelLoadingMaxRetry: 2,
            levelLoadingRetryDelay: 1500,
            fragLoadingMaxRetry: 2,
            fragLoadingRetryDelay: 1000,
          });
          hlsRef.current = hls;
          hls.loadSource(manifestUrl);
          hls.attachMedia(video);

          // Buffering overlay drivers — track buffer fill around currentTime
          // and toggle the inline spinner. Listening to both video element
          // events (waiting/playing/seeking/seeked/canplay) AND hls.js
          // fragment events gives us accurate state in all three cases:
          // initial buffer fill, seek re-buffer, mid-playback network stall.
          // Debounce the spinner: hls.js fires brief sub-100ms `waiting`
          // events between fragment swaps that are NOT real stalls. Showing
          // a spinner for these creates a visual flicker every few seconds
          // that users perceive as "freezing every 3 seconds" even though
          // playback is fine. We only show the overlay if `waiting` persists
          // beyond 400ms. Explicit user-triggered events (seek) skip the
          // debounce because the user expects immediate feedback.
          let waitingDebounceTimer: ReturnType<typeof setTimeout> | null = null;
          const clearWaitingTimer = () => {
            if (waitingDebounceTimer) {
              clearTimeout(waitingDebounceTimer);
              waitingDebounceTimer = null;
            }
          };
          const onWaiting = () => {
            clearWaitingTimer();
            waitingDebounceTimer = setTimeout(() => {
              setIsBuffering(true);
              waitingDebounceTimer = null;
            }, 400);
          };
          const onSeeking = () => {
            clearWaitingTimer();
            setIsBuffering(true);
            setBufferPct(0);
          };
          const onSeeked = () => {
            // Don't clear immediately — the decoder needs a moment to paint.
            // The `playing` / `canplay` event below clears it when frames flow.
          };
          const onPlaying = () => { clearWaitingTimer(); setIsBuffering(false); };
          const onCanPlay = () => { clearWaitingTimer(); setIsBuffering(false); };
          const updateBuffer = () => {
            // bufferPct  — fill % of the 30s HLS buffer window (spinner label)
            // bufferedEndPct — how far along the timeline is buffered (seek bar)
            try {
              const v = videoRef.current;
              if (!v) return;
              // Settle the startup resume-clobber guard once playback actually
              // reaches the saved position, so genuine user seeks afterwards
              // (including a rewind to the start) are honored normally.
              if (initialResumeTargetRef.current > 1 && v.currentTime >= initialResumeTargetRef.current - 2) {
                initialResumeTargetRef.current = -1;
              }
              if (!v.buffered || v.buffered.length === 0) return;
              const ct = v.currentTime;
              const dur = v.duration;
              let ahead = 0;
              let bufferedEnd = 0;
              for (let i = 0; i < v.buffered.length; i++) {
                if (v.buffered.start(i) <= ct + 0.1 && v.buffered.end(i) >= ct) {
                  ahead = v.buffered.end(i) - ct;
                  bufferedEnd = v.buffered.end(i);
                  break;
                }
              }
              const pct = Math.max(0, Math.min(100, Math.round((ahead / 30) * 100)));
              setBufferPct(pct);
              if (dur > 0) setBufferedEndPct(Math.min(100, (bufferedEnd / dur) * 100));
            } catch {}
          };
          const onProgress = updateBuffer;
          video.addEventListener("waiting", onWaiting);
          video.addEventListener("seeking", onSeeking);
          video.addEventListener("seeked", onSeeked);
          video.addEventListener("playing", onPlaying);
          video.addEventListener("canplay", onCanPlay);
          video.addEventListener("progress", onProgress);
          video.addEventListener("timeupdate", updateBuffer);

          // Control bridge: relay native video play/pause events to parent
          // Suppress PAUSE notifications that are caused by our internal seek
          // sequence (applyPendingSeek pauses the video before seeking).
          const onVideoPlay = () => postToParent({ type: "PLAY", time: video.currentTime });
          const onVideoPause = () => { if (!isSeeking.current) postToParent({ type: "PAUSE", time: video.currentTime }); };
          video.addEventListener("play", onVideoPlay);
          video.addEventListener("pause", onVideoPause);

          // ── NATIVE SEEK HOOK ──────────────────────────────────────────
          // The browser's native HTML5 controls (keyboard arrows, spacebar
          // tap-seek, fullscreen scrubber, OS media keys) bypass our
          // performLocalSeek / applyPendingSeek paths entirely — so without
          // this listener, those seeks never POST progress and the server
          // sliding window stays at the old position. Every chunk request
          // for the new position then 403s as out-of-window, freezing the
          // player for 30-45s. This handler detects ANY native seek that
          // wasn't initiated by our own helpers (isSeeking.current=false)
          // and reproduces the same proactive window advance.
          const onNativeSeeking = () => {
            // Skip during session rotation — hls.loadSource() snaps
            // currentTime→0 synchronously when the new source is loaded.
            // Without this guard, onNativeSeeking fires with target=0 and
            // posts seekTo:0 to the server, resetting the sliding window
            // to segment 0 and restarting playback from the beginning
            // even though the player is mid-rotation to resume at savedTime.
            if (isRotatingRef.current) return;
            // Skip if EITHER of our internal seek helpers is already
            // driving this seek — they have already fired the POST and
            // raised the seek guard. Without this check, every call to
            // `performLocalSeek` / `applyPendingSeek` produced TWO
            // /progress posts: one from the helper, one re-entered here
            // when `v.currentTime = newTime` synthesised a native
            // `seeking` event. That was the source of the alternating
            // `targetSegmentIndex` values the user observed in the logs.
            if (isSeeking.current || isSeekingRef.current) return;
            const sid = streamSidRef.current;
            if (!sid || !publicId) return;
            const target = video.currentTime;
            // STARTUP RESUME-CLOBBER GUARD. While the saved-position resume is
            // still buffering (initialResumeTargetRef armed and not yet reached),
            // HLS.js can synthesize a `seeking` event that snaps currentTime to
            // ~0. That is NOT a user seek — reporting it as seekTo:true resets
            // the server window to 0 and restarts playback from the beginning
            // (the 322→0 jump in the logs). Suppress the POST and re-assert the
            // resume position a bounded number of times so the video does not
            // silently drop to 0. A 30s ceiling prevents a permanently-stuck
            // resume from locking out a legitimate later seek-to-start.
            const resumeTarget = initialResumeTargetRef.current;
            const resumeStale = initialResumeSetAtRef.current > 0 && Date.now() - initialResumeSetAtRef.current > 30000;
            if (resumeTarget > 10 && !resumeStale && target < 3) {
              if (resumeReassertCountRef.current < 3) {
                resumeReassertCountRef.current++;
                try {
                  const h = hlsRef.current;
                  if (h) h.stopLoad();
                  video.currentTime = resumeTarget;
                  if (h) h.startLoad(resumeTarget);
                } catch {}
              }
              return;
            }
            // A genuine native seek (not a startup snap-to-start) means the user
            // has taken control — disarm the startup resume guard so subsequent
            // seeks (including a deliberate rewind to the start) are never
            // suppressed even if the original resume offset was never reached.
            if (initialResumeTargetRef.current > 1) initialResumeTargetRef.current = -1;
            lastSeekAtRef.current = Date.now();
            seekRecoveryCountRef.current = 0;
            const hls = hlsRef.current;
            if (hls) hls.stopLoad();
            const resume = () => { if (hls) hls.startLoad(target); };
            // Bounded wait so a stalled POST cannot leave the player frozen.
            // seekProgressWithTimeout raises isSeekingRef internally.
            seekProgressWithTimeout(sid, target).then(resume, resume);
          };
          video.addEventListener("seeking", onNativeSeeking);

          // Track media error recovery attempts to avoid infinite loops
          let mediaErrorRecoveries = 0;

          hls.on(Hls.Events.MANIFEST_PARSED, (_, hlsData) => {
            // PART 5 diagnostic: surface every HLS level so we can see at a
            // glance whether the master had multiple variants. If this logs a
            // single level, the issue is upstream (transcode / master rewrite),
            // NOT the UI selector logic.
            try {
              const levelSummary = hlsData.levels.map((l: any, i: number) => ({
                i,
                height: l.height,
                width: l.width,
                bitrate: l.bitrate,
                url: Array.isArray(l.url) ? l.url[0] : l.url,
              }));
              console.info("[HLS] MANIFEST_PARSED levels=", levelSummary.length, levelSummary);
              if (hlsData.levels.length <= 1) {
                console.warn("[HLS] Only one HLS level detected — quality selector hidden because master has one variant. Check /api/player/:publicId/stream/master response for #EXT-X-STREAM-INF count.");
              }
            } catch {}
            setQualities(hlsData.levels.map((l, i) => ({ height: l.height, index: i })));
            setStatus("ready");
            playerReadyRef.current = true;
            const dur = (hlsData as any).totalduration || (hlsData.levels[0]?.details?.totalduration) || 0;
            if (import.meta.env.DEV) console.debug("[EmbedControl] PLAYER_READY");
            postToParent({ type: "PLAYER_READY", publicId, duration: dur });
            // With autoStartLoad:false HLS.js never auto-starts. For the initial
            // (non-rotation) load we kick off loading here. Rotation once-handlers
            // call hls.startLoad(resumeAt) instead — skipped by the guard below.
            if (!isRotatingRef.current) {
              hls.startLoad(-1);
              // Apply any pending URL-based or postMessage seek after a short
              // delay so the manifest details are available to hls.js.
              setTimeout(() => applyPendingSeek(), 80);
            }
            // Suppress autoplay during rotation — the rotation handler restores position and plays
            if (playerSettings.autoplayAllowed && !isRotatingRef.current) video.play().catch(() => {});
          });
          hls.on(Hls.Events.LEVEL_LOADED, (_, d) => {
            const total = d.details?.totalduration;
            if (total && isFinite(total) && total > 0) setDuration(prev => prev > 0 ? prev : total);
          });
          // Healthy playback resets the fatal-recovery budget AND samples
          // the last known good time. As long as fragments keep arriving,
          // transient blips never accumulate to the point of triggering the
          // "Network unstable" error, and we always have a fresh resume
          // position even if currentTime briefly reads 0 during a buffer
          // tear-down.
          hls.on(Hls.Events.FRAG_LOADED, () => {
            if (fatalRecoveryLogRef.current.length > 0) fatalRecoveryLogRef.current = [];
            if (deferredRetryTimerRef.current) {
              clearTimeout(deferredRetryTimerRef.current);
              deferredRetryTimerRef.current = null;
            }
            const t = videoRef.current?.currentTime ?? 0;
            if (t > 0.25) lastHealthyTimeRef.current = t;
          });
          hls.on(Hls.Events.ERROR, (_, d) => {
            const code = (d as any).response?.code;
            const responseText = (d as any).response?.text || "";

            // Suppress harmless aborted/cancelled requests — these fire when
            // hls.stopLoad() runs during seek/rotation/destroy and are NOT
            // real errors. We require an explicit *Abort detail string OR a
            // non-fatal error whose reason text matches abort/cancelled —
            // we do NOT suppress on `code === 0` alone, because that code
            // also covers real transport failures (offline, CORS, reset)
            // that must still flow through the recovery ladder.
            const details = (d as any).details || "";
            const reasonText = (responseText || "").toLowerCase();
            const isExplicitAbort =
              details === "internalAbort" ||
              details === "fragLoadAbort" ||
              details === "keyLoadAbort" ||
              details === "manifestLoadAbort" ||
              details === "levelLoadAbort";
            const isCancelledNonFatal =
              !d.fatal && code === 0 && (reasonText.includes("abort") || reasonText.includes("cancel"));
            if (isExplicitAbort || isCancelledNonFatal) return;

            // Non-fatal network errors: try startLoad() to resume stalled downloads.
            // Suppress during rotation — old cancelled requests produce noise here and
            // calling startLoad() while the new source is loading would cancel it.
            if (!d.fatal) {
              if (d.type === Hls.ErrorTypes.NETWORK_ERROR && !isRotatingRef.current) hls.startLoad();
              return;
            }

            if (isRotatingRef.current) return;

            // Parse signal/errorCode from response body if any (used by both
            // 403/401 branch and the NETWORK_ERROR fallback).
            let signal = "";
            let errorCode = "";
            try {
              const parsed = JSON.parse(responseText);
              if (parsed?.signal) signal = parsed.signal;
              if (parsed?.code) errorCode = parsed.code;
            } catch {}

            // Hoisted: callable from BOTH the 403/401 path AND the fatal
            // NETWORK_ERROR escalation path. Many real-world failures
            // surface as NETWORK_ERROR (no HTTP code reaches hls.js because
            // the request was aborted/reset) but the underlying cause is
            // token/session expiry — and the only recovery that actually
            // works is rotating to a fresh session.
            const tryRotationRecovery = (fallbackSignal?: string) => {
              const currentSid = streamSidRef.current;
              const sig = fallbackSignal || signal || "rate_limit";
              if (!currentSid) { triggerDenial(sig); return; }
              // Prefer the last *healthy* playback position over a live read
              // of currentTime, because by the time we get here the video
              // element may have already reset to 0 (MSE tear-down during
              // the previous rotation, or fatal-error pause). Falling back
              // to lastHealthyTimeRef prevents the "restart from zero" UX bug.
              const liveTime = videoRef.current?.currentTime || 0;
              const savedTime = liveTime > 0.25 ? liveTime : (lastHealthyTimeRef.current || 0);
              isRotatingRef.current = true;
              fetch(`/api/player/${publicId}/rotate-session`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sid: currentSid, currentTime: savedTime }),
              }).then(async r => {
                if (!r.ok) { isRotatingRef.current = false; triggerDenial(sig); return; }
                const rd = await r.json();
                if (rd.manifestUrl && rd.sessionId) {
                  streamSidRef.current = rd.sessionId;
                  const opId = ++rotationOpIdRef.current;
                  isRotatingRef.current = true;
                  const nextUrl = (rd.stealth && rd.stealth.enabled && rd.stealth.streamUrl) ? rd.stealth.streamUrl : rd.manifestUrl;
                  hls.loadSource(nextUrl);
                  const vid = videoRef.current;
                  const safetyTimer = setTimeout(() => {
                    if (opId !== rotationOpIdRef.current) return;
                    if (isRotatingRef.current) {
                      isRotatingRef.current = false;
                      const resumeAt = pendingMessageSeekRef.current ?? savedTime;
                      if (vid) { hls.stopLoad(); hls.startLoad(resumeAt); vid.currentTime = resumeAt; vid.play().catch(() => {}); }
                      // MANIFEST_PARSED never fired — re-anchor progress
                      // ourselves so the (preserved) sliding window matches
                      // wherever we actually resumed playback. Authoritative
                      // re-anchor for the new session, routed through the
                      // central sendProgress dispatcher (which applies the
                      // stale-zero guard before sending).
                      sendProgress("rotation", resumeAt, { sid: rd.sessionId, seekTo: true });
                      if (pendingMessageSeekRef.current !== null) applyPendingSeek();
                    }
                  }, 15000);
                  hls.once(Hls.Events.MANIFEST_PARSED, () => {
                    clearTimeout(safetyTimer);
                    if (opId !== rotationOpIdRef.current) return;
                    isRotatingRef.current = false;
                    lastRotationAtRef.current = Date.now();
                    const resumeAt = pendingMessageSeekRef.current ?? savedTime;
                    // autoStartLoad:false — this is the ONLY startLoad call,
                    // so HLS.js fetches from resumeAt without any race.
                    // Do NOT set vid.currentTime here: the MSE buffer is empty
                    // at MANIFEST_PARSED so the seek would be silently ignored.
                    // Instead apply it in FRAG_BUFFERED once a segment near
                    // resumeAt has been appended and the range is seekable.
                    hls.startLoad(resumeAt);
                    const doSeekAndPlay = () => {
                      if (vid) {
                        try { vid.currentTime = resumeAt; } catch {}
                        vid.play().catch(() => {});
                      }
                    };
                    hls.once(Hls.Events.FRAG_BUFFERED, doSeekAndPlay);
                    if (pendingMessageSeekRef.current !== null) {
                      applyPendingSeek();
                    }
                    sendProgress("rotation", resumeAt, { sid: rd.sessionId, seekTo: true });
                  });
                } else {
                  triggerDenial(sig);
                }
              }).catch(() => triggerDenial(sig));
            };

            // Fatal 403/401 — security denial or token expiry
            if (code === 403 || code === 401) {
                hls.stopLoad();
                videoRef.current?.pause();

                // Recoverable (silent retry): token expiry, sliding-window prefetch overshoot,
                // session expired, transient rate spikes. These happen during normal HLS
                // playback (seeks, quality switches, hls.js retries) and must NOT show the
                // suspicious-activity overlay.
                // Try to read X-Playback-Error header — set by the server on
                // every 403 from stealth media routes. hls.js doesn't expose
                // headers directly in the error event, but the loader's
                // underlying XHR is reachable for our custom loader path.
                let headerCode = "";
                try {
                  const xhr = (d as any)?.frag?.loader?.loader || (d as any)?.context?.loader?.loader || (d as any)?.networkDetails;
                  if (xhr && typeof xhr.getResponseHeader === "function") {
                    headerCode = xhr.getResponseHeader("X-Playback-Error") || "";
                  }
                } catch {}
                const finalCode = headerCode || errorCode;
                const isExpiry =
                  finalCode === "TOKEN_EXPIRED" ||
                  finalCode === "SIGNED_URL_EXPIRED" ||
                  finalCode === "SEGMENT_WINDOW_VIOLATION" ||
                  finalCode === "SESSION_EXPIRED" ||
                  finalCode === "WINDOW_EXPIRED" ||
                  finalCode === "SECRET_EXPIRED" ||
                  finalCode === "OPAQUE_ID_EXPIRED" ||
                  finalCode === "SESSION_ROTATED" ||
                  finalCode === "HEARTBEAT_STALE" ||
                  finalCode === "OUT_OF_WINDOW" ||
                  signal === "token_expired" ||
                  signal === "signed_url_expired" ||
                  signal === "out_of_window" ||
                  signal === "heartbeat_invalid" ||
                  signal === "rotated" ||
                  signal === "rate_limit";
                // True abuse: only show the denial overlay for these signals/codes.
                // NOTE: SESSION_REVOKED is intentionally NOT here — on a multi-instance
                // backend the old SID can briefly read as "revoked" from a sibling
                // instance during/after rotation. Treat it as recoverable and let
                // /refresh-token attempt to mint a new session. If refresh ALSO
                // fails (truly revoked), the existing failure path shows the overlay.
                const isTrueAbuse =
                  finalCode === "BLOCKED_SUSPICIOUS_ACTIVITY" ||
                  finalCode === "VIDEO_BLOCKED" ||
                  finalCode === "SECURITY_BULK_DOWNLOAD" ||
                  signal === "bulk_download" ||
                  signal === "velocity_abuse" ||
                  signal === "key_abuse" ||
                  signal === "hook_detected" ||
                  signal === "concurrent" ||
                  signal === "playlist_abuse";
                // Allow refresh attempt for SESSION_REVOKED — recoverable in
                // most cases (cross-instance rotation race, fresh-session
                // misread). Real revocation is caught when refresh fails.
                const recoverFromRevoke =
                  finalCode === "SESSION_REVOKED" || finalCode === "HEARTBEAT_STALE";
                const canRefresh = activeTokenRef.current && (isExpiry || recoverFromRevoke) && !isTrueAbuse;

                // ── POST-SEEK 403 LIGHTWEIGHT RECOVERY ─────────────────
                // A 403 that arrives within ~6s of a user seek is almost
                // always an out-of-window race: an in-flight fragment
                // request for the OLD position landed AFTER the server
                // had advanced its window to the new position, or vice
                // versa. Doing a full session rotation here would freeze
                // the player 5-15s with a black screen. Instead: re-POST
                // progress with the current position (within the seek
                // grace window, the server will accept and reset
                // outOfWindowCount) and restart loading. Bounded to 3
                // attempts per seek to avoid infinite loops.
                const sinceSeekMs = Date.now() - lastSeekAtRef.current;
                const inSeekGrace = lastSeekAtRef.current > 0 && sinceSeekMs < 6000;
                if (!isTrueAbuse && inSeekGrace && seekRecoveryCountRef.current < 3) {
                  const sid = streamSidRef.current;
                  const target = videoRef.current?.currentTime ?? 0;
                  seekRecoveryCountRef.current += 1;
                  if (sid && publicId) {
                    sendProgress("seek-recovery", target, { sid, seekTo: true }).then(() => {
                      try { hls.stopLoad(); } catch {}
                      try { hls.startLoad(target); } catch {}
                      videoRef.current?.play().catch(() => {});
                    });
                  } else {
                    try { hls.stopLoad(); hls.startLoad(target); } catch {}
                  }
                  return;
                }

                if (canRefresh) {
                  const savedTime = videoRef.current?.currentTime || 0;
                  fetch(`/api/player/${publicId}/refresh-token`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token: activeTokenRef.current }),
                  }).then(async r => {
                    if (!r.ok) { triggerDenial(signal || "rate_limit"); return; }
                    const rd = await r.json();
                    if (rd.token) activeTokenRef.current = rd.token;
                    if (rd.manifestUrl) {
                      // The server mints a brand-new playback session on
                      // refresh-token. The new SID lives in the new manifest
                      // URL, but heartbeat / progress / security-event calls
                      // all use streamSidRef.current — without this swap they
                      // keep hammering the dead old SID and the player freezes
                      // ~7-8 min in once the old SID's idle TTL bucket flips.
                      if (rd.sessionId) {
                        streamSidRef.current = rd.sessionId;
                        heartbeatSeqRef.current = 0;
                      }
                      const opId = ++rotationOpIdRef.current;
                      isRotatingRef.current = true;
                      const nextUrl = (rd.stealth && rd.stealth.enabled && rd.stealth.streamUrl) ? rd.stealth.streamUrl : rd.manifestUrl;
                      hls.loadSource(nextUrl);
                      const vid = videoRef.current;
                      // refresh-token mints a BRAND-NEW session whose
                      // currentSegmentIndex is initialised to 0 (unlike
                      // rotate-session, which spreads the old session and
                      // preserves the index). Without an authoritative
                      // re-anchor here the new session's sliding window
                      // stays at [0, windowSegs], and the player's first
                      // chunk request for the resumed position will trip
                      // out_of_window 403. The post below uses seekTo:true
                      // so it is accepted even though it moves the index
                      // "forward" from 0 to resumeAt.
                      const reanchorProgress = (resumeAt: number) => {
                        sendProgress("refresh", resumeAt, { sid: rd.sessionId, seekTo: true });
                      };
                      const refreshSafetyTimer = setTimeout(() => {
                        if (opId !== rotationOpIdRef.current) return;
                        if (isRotatingRef.current) {
                          isRotatingRef.current = false;
                          const resumeAt = pendingMessageSeekRef.current ?? savedTime;
                          if (vid) { hls.stopLoad(); hls.startLoad(resumeAt); vid.currentTime = resumeAt; vid.play().catch(() => {}); }
                          reanchorProgress(resumeAt);
                          if (pendingMessageSeekRef.current !== null) applyPendingSeek();
                        }
                      }, 15000);
                      hls.once(Hls.Events.MANIFEST_PARSED, () => {
                        clearTimeout(refreshSafetyTimer);
                        if (opId !== rotationOpIdRef.current) return;
                        isRotatingRef.current = false;
                        const resumeAt = pendingMessageSeekRef.current ?? savedTime;
                        hls.startLoad(resumeAt);
                        const doSeekAndPlay = () => {
                          if (vid) {
                            try { vid.currentTime = resumeAt; } catch {}
                            vid.play().catch(() => {});
                          }
                        };
                        hls.once(Hls.Events.FRAG_BUFFERED, doSeekAndPlay);
                        reanchorProgress(resumeAt);
                        if (pendingMessageSeekRef.current !== null) applyPendingSeek();
                      });
                    } else {
                      triggerDenial(signal || "rate_limit");
                    }
                  }).catch(() => triggerDenial(signal || "rate_limit"));
                } else if (!isTrueAbuse) {
                  // Honour the same rotation cool-down as the NETWORK_ERROR
                  // path. If we just rotated, prefer a passive startLoad
                  // and let the (already-rotated) signed URLs do their job
                  // rather than chaining another rotation 10s later.
                  if (Date.now() - lastRotationAtRef.current > ROTATION_COOLDOWN_MS) {
                    tryRotationRecovery();
                  } else {
                    hls.startLoad();
                    videoRef.current?.play().catch(() => {});
                  }
                } else {
                  triggerDenial(signal || "rate_limit");
                }
            } else if (code === 404) {
                let parsedCode = "";
                try { parsedCode = JSON.parse(responseText)?.code ?? ""; } catch {}
                if (parsedCode === "ORIGIN_PLAYLIST_NOT_FOUND") {
                  setStatus("error");
                  setErrorMsg("Stream source not found. Video processing may be incomplete or the storage path is missing.");
                } else {
                  setStatus("error");
                  setErrorMsg("Stream error");
                }
            } else if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
                // Fatal network error escalation ladder:
                //  - Attempts 1–2: fast hls.startLoad() retry against the same
                //    URLs. Handles transient blips.
                //  - Attempts 3+: many "network errors" actually mean token/
                //    session expiry that surfaced as an aborted request
                //    (no HTTP code reached hls.js). The only real recovery
                //    is a full session rotation that mints fresh signed URLs.
                //  - Budget exhausted: deferred final retry, then fatal.
                const fastRetryCount = fatalRecoveryLogRef.current.length;
                if (fastRetryCount < 2) {
                  if (!guardedFatalRestart(hls)) {
                    setStatus("error");
                    setErrorMsg("Network unstable. Please refresh to retry.");
                  }
                } else if (
                  streamSidRef.current &&
                  !isRotatingRef.current &&
                  Date.now() - lastRotationAtRef.current > ROTATION_COOLDOWN_MS
                ) {
                  // Escalate to session rotation. Burn one budget slot so
                  // the breaker still applies if rotation itself fails.
                  // Cool-down prevents rotation churn when the server keeps
                  // emitting recoverable failures (each rotation has a brief
                  // black-screen during MSE re-attach, so back-to-back
                  // rotations are worse UX than a few extra startLoad calls).
                  fatalRecoveryLogRef.current.push(Date.now());
                  hls.stopLoad();
                  tryRotationRecovery("network_error");
                } else {
                  if (!guardedFatalRestart(hls)) {
                    setStatus("error");
                    setErrorMsg("Network unstable. Please refresh to retry.");
                  }
                }
            } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
                // Fatal media error — attempt recovery before giving up
                if (mediaErrorRecoveries < 3) {
                  mediaErrorRecoveries += 1;
                  hls.recoverMediaError();
                } else {
                  setStatus("error");
                  setErrorMsg("Stream error");
                }
            } else {
                setStatus("error");
                setErrorMsg("Stream error");
            }
          });

          // ── STALL DETECTOR + RECOVERY LADDER ──────────────────────────
          // Polls currentTime every 3 s while video.paused=false.
          // 3 consecutive no-progress ticks (~9 s) → trigger the ladder:
          //
          //   L1 (~9 s stall)  : recoverMediaError + startLoad(ct) + play
          //   L2 (+5 s stuck)  : nudge ct+0.2, startLoad, play
          //   L3 (+5 s stuck)  : POST rotate-session → fresh manifest → seek+play
          //
          // Intentionally separate from the ERROR handler — this catches
          // *silent* stalls where HLS.js never emits a fatal error (the most
          // common case when ping/tick/chunks are all 200 but video freezes).
          // Skipped during rotation, seeking, deliberate pause, or initial load.
          const STALL_POLL_MS = 3000;
          const STALL_TICKS = 3; // 3 × 3 s ≈ 9 s before L1

          stallLastTimeRef.current = -1;
          stallTicksRef.current = 0;
          stallRecoveryLevelRef.current = 0;
          isStallRecoveringRef.current = false;

          const clearStallRecoveryTimer = () => {
            if (stallRecoveryTimerRef.current) {
              clearTimeout(stallRecoveryTimerRef.current);
              stallRecoveryTimerRef.current = null;
            }
          };

          const runStallRecovery = (ct: number) => {
            const vid = videoRef.current;
            const h = hlsRef.current;
            if (!vid || !h || isRotatingRef.current) return;

            // ── Level 1: recoverMediaError + startLoad ──────────────────
            stallRecoveryLevelRef.current = 1;
            isStallRecoveringRef.current = true;
            console.info("[HLS] HLS_SOFT_RECOVERY_START", { currentTime: ct });
            try { h.recoverMediaError(); } catch {}
            try { h.startLoad(ct); } catch {}
            vid.play().catch(() => {});

            clearStallRecoveryTimer();
            stallRecoveryTimerRef.current = setTimeout(() => {
              stallRecoveryTimerRef.current = null;
              if (!isStallRecoveringRef.current) return; // already cleared by playing event
              const v2 = videoRef.current;
              const h2 = hlsRef.current;
              if (!v2 || !h2 || isRotatingRef.current) {
                isStallRecoveringRef.current = false;
                return;
              }

              // ── Level 2: nudge +0.2 ──────────────────────────────────
              stallRecoveryLevelRef.current = 2;
              const t2 = v2.currentTime;
              console.info("[HLS] HLS_BUFFER_NUDGE", { currentTime: t2 });
              try { v2.currentTime = t2 + 0.2; } catch {}
              try { h2.startLoad(); } catch {}
              v2.play().catch(() => {});

              clearStallRecoveryTimer();
              stallRecoveryTimerRef.current = setTimeout(() => {
                stallRecoveryTimerRef.current = null;
                if (!isStallRecoveringRef.current) return;
                const v3 = videoRef.current;
                const h3 = hlsRef.current;
                if (!v3 || !h3 || isRotatingRef.current) {
                  isStallRecoveringRef.current = false;
                  stallRecoveryLevelRef.current = 0;
                  return;
                }

                // ── Level 3: rotate-session → fresh manifest ────────────
                const t3 = v3.currentTime;
                const sid3 = streamSidRef.current;
                if (!sid3 || !publicId) {
                  console.warn("[HLS] HLS_RECOVERY_FAILED", { level: 3, reason: "no-sid" });
                  isStallRecoveringRef.current = false;
                  stallRecoveryLevelRef.current = 0;
                  return;
                }
                console.info("[HLS] HLS_FULL_RELOAD_START", { currentTime: t3 });
                isRotatingRef.current = true;
                fetch(`/api/player/${publicId}/rotate-session`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ sid: sid3, currentTime: t3 }),
                }).then(async r => {
                  if (!r.ok) {
                    console.warn("[HLS] HLS_RECOVERY_FAILED", { level: 3, status: r.status });
                    isRotatingRef.current = false;
                    isStallRecoveringRef.current = false;
                    stallRecoveryLevelRef.current = 0;
                    return;
                  }
                  const rd = await r.json();
                  if (!rd.manifestUrl || !rd.sessionId) {
                    console.warn("[HLS] HLS_RECOVERY_FAILED", { level: 3, reason: "bad-response" });
                    isStallRecoveringRef.current = false;
                    stallRecoveryLevelRef.current = 0;
                    return;
                  }
                  const h4 = hlsRef.current;
                  const v4 = videoRef.current;
                  if (!h4 || !v4) {
                    isStallRecoveringRef.current = false;
                    stallRecoveryLevelRef.current = 0;
                    return;
                  }
                  streamSidRef.current = rd.sessionId;
                  isRotatingRef.current = true;
                  lastRotationAtRef.current = Date.now();
                  const freshUrl = (rd.stealth?.enabled && rd.stealth.streamUrl)
                    ? rd.stealth.streamUrl
                    : rd.manifestUrl;
                  const resumeAt = t3 + 0.2;
                  h4.loadSource(freshUrl);
                  const l3Safety = setTimeout(() => {
                    isRotatingRef.current = false;
                    isStallRecoveringRef.current = false;
                    stallRecoveryLevelRef.current = 0;
                    console.warn("[HLS] HLS_RECOVERY_FAILED", { level: 3, reason: "manifest-timeout" });
                    try { h4.stopLoad(); h4.startLoad(resumeAt); } catch {}
                    try { v4.currentTime = resumeAt; v4.play().catch(() => {}); } catch {}
                  }, 15000);
                  h4.once(Hls.Events.MANIFEST_PARSED, () => {
                    clearTimeout(l3Safety);
                    isRotatingRef.current = false;
                    lastRotationAtRef.current = Date.now();
                    h4.startLoad(resumeAt);
                    h4.once(Hls.Events.FRAG_BUFFERED, () => {
                      try { v4.currentTime = resumeAt; } catch {}
                      v4.play().catch(() => {});
                      isStallRecoveringRef.current = false;
                      stallRecoveryLevelRef.current = 0;
                      console.info("[HLS] HLS_RECOVERY_SUCCESS", { level: 3, resumeAt });
                    });
                  });
                  sendProgress("rotation", resumeAt, { sid: rd.sessionId, seekTo: true });
                }).catch(() => {
                  console.warn("[HLS] HLS_RECOVERY_FAILED", { level: 3, reason: "fetch-error" });
                  isStallRecoveringRef.current = false;
                  stallRecoveryLevelRef.current = 0;
                });
              }, 5000);
            }, 5000);
          };

          // Clear stall state the moment healthy playback resumes
          const onStallPlayingEvent = () => {
            if (stallTicksRef.current > 0 || isStallRecoveringRef.current) {
              stallTicksRef.current = 0;
              stallLastTimeRef.current = videoRef.current?.currentTime ?? -1;
              if (isStallRecoveringRef.current && stallRecoveryLevelRef.current > 0) {
                console.info("[HLS] HLS_RECOVERY_SUCCESS (playing event)", { level: stallRecoveryLevelRef.current });
                isStallRecoveringRef.current = false;
                stallRecoveryLevelRef.current = 0;
                clearStallRecoveryTimer();
              }
            }
          };
          video.addEventListener("playing", onStallPlayingEvent);

          // Fast-track stall counter on native `stalled` event
          const onNativeStalled = () => {
            if (!video.paused && !video.ended && !isRotatingRef.current && !isSeekingRef.current && !isSeeking.current) {
              stallTicksRef.current = Math.max(stallTicksRef.current, STALL_TICKS - 1);
            }
          };
          video.addEventListener("stalled", onNativeStalled);

          // Fast-track stall counter on non-fatal HLS buffer/fragment errors
          // (these precede or accompany a silent stall — arming the counter
          // means recovery kicks in ~3 s sooner than the pure polling path).
          hls.on(Hls.Events.ERROR, (_, dStall) => {
            if (dStall.fatal || isRotatingRef.current || isStallRecoveringRef.current) return;
            const det = (dStall as any).details || "";
            if (
              det === "bufferStalledError" ||
              det === "fragLoadError"      ||
              det === "levelLoadError"     ||
              det === "fragLoadTimeOut"    ||
              det === "levelLoadTimeOut"
            ) {
              stallTicksRef.current = Math.max(stallTicksRef.current, STALL_TICKS - 1);
            }
          });

          // ── 3-second poll ────────────────────────────────────────────
          stallDetectorIntervalRef.current = setInterval(() => {
            const vid = videoRef.current;
            // Not playing or not yet ready — reset tracking, skip
            if (!vid || vid.paused || vid.ended || !playerReadyRef.current) {
              if (!isStallRecoveringRef.current) {
                stallTicksRef.current = 0;
                stallLastTimeRef.current = -1;
              }
              return;
            }
            // Rotation/seek in progress — don't interfere
            if (isRotatingRef.current || isSeekingRef.current || isSeeking.current) {
              stallTicksRef.current = 0;
              stallLastTimeRef.current = -1;
              return;
            }
            const ct = vid.currentTime;
            if (stallLastTimeRef.current < 0) {
              stallLastTimeRef.current = ct;
              return;
            }
            const delta = ct - stallLastTimeRef.current;
            stallLastTimeRef.current = ct;

            if (delta > 0.1) {
              // Healthy progress — reset
              stallTicksRef.current = 0;
              if (isStallRecoveringRef.current) {
                console.info("[HLS] HLS_RECOVERY_SUCCESS (progress confirmed)", { level: stallRecoveryLevelRef.current });
                isStallRecoveringRef.current = false;
                stallRecoveryLevelRef.current = 0;
                clearStallRecoveryTimer();
              }
              return;
            }
            if (isStallRecoveringRef.current) return; // ladder already running
            stallTicksRef.current += 1;
            if (stallTicksRef.current >= STALL_TICKS) {
              stallTicksRef.current = 0;
              console.info("[HLS] HLS_STALL_DETECTED", { currentTime: ct, ticks: STALL_TICKS });
              runStallRecovery(ct);
            }
          }, STALL_POLL_MS);

        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = manifestUrl;
          video.addEventListener("play", () => postToParent({ type: "PLAY", time: video.currentTime }));
          video.addEventListener("pause", () => { if (!isSeeking.current) postToParent({ type: "PAUSE", time: video.currentTime }); });
          video.addEventListener("loadedmetadata", () => {
            setStatus("ready");
            playerReadyRef.current = true;
            if (import.meta.env.DEV) console.debug("[EmbedControl] PLAYER_READY (native)");
            postToParent({ type: "PLAYER_READY", publicId, duration: video.duration || 0 });
            setTimeout(() => applyPendingSeek(), 80);
          });
        } else {
          setStatus("error");
          setErrorMsg("HLS not supported in this browser");
        }
      } catch (e: any) {
        setStatus("error");
        setErrorMsg(e.message || "Failed to load");
      }
    };

    init();

    return () => {
      hlsRef.current?.destroy();
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
      if (popIntervalRef.current) clearInterval(popIntervalRef.current);
      if (rotationIntervalRef.current) clearInterval(rotationIntervalRef.current);
      if (tickIntervalRef.current) clearInterval(tickIntervalRef.current);
      if (stallDetectorIntervalRef.current) clearInterval(stallDetectorIntervalRef.current);
      if (stallRecoveryTimerRef.current) clearTimeout(stallRecoveryTimerRef.current);
    };
  }, [publicId, token, retryKey]);

  // P3: keep refs synced so the unified tick effect can read the latest
  // values without listing them as effect deps (would re-create the timer
  // every second as secondsWatched ticks up).
  useEffect(() => { secondsWatchedRef.current = secondsWatched; }, [secondsWatched]);
  useEffect(() => { sessionCodeRef.current = sessionCode || null; }, [sessionCode]);

  // ── UNIFIED TICK LOOP (P3) ────────────────────────────────────────────
  // Consolidates the former /progress (20s), /heartbeat (~30s), and /ping
  // (60s) intervals into a single 20s tick that POSTs /api/player/:pub/tick.
  //
  // Per-subsystem cadence is controlled by a counter:
  //   tick 1: progress
  //   tick 2: progress + heartbeat                     (~40s after start)
  //   tick 3: progress           + ping                (~60s after start)
  //   tick 4: progress + heartbeat
  //   tick 5: progress
  //   tick 6: progress + heartbeat + ping              (every 60s thereafter)
  //
  // Net: 6 separate req/min/session → 3 unified req/min/session (-50%).
  //
  // The old /progress, /heartbeat, /ping endpoints stay alive as server-
  // side shims so in-flight players from before this deploy keep working.
  // Imperative one-off progress posts (seek, pause, end, rotation-complete)
  // still go through sendProgress() → /progress shim and are unaffected.
  //
  // Final tick: on pause / end / visibility:hidden / beforeunload / pagehide
  // we fire a final tick via navigator.sendBeacon so the analytics flush
  // survives page teardown. `final:true` is informational for future P4
  // server-side buffering.
  useEffect(() => {
    if (!streamSidRef.current || !publicId) return;
    if (tickIntervalRef.current) {
      clearInterval(tickIntervalRef.current);
      tickIntervalRef.current = null;
    }
    tickCounterRef.current = 0;
    finalTickFiredRef.current = false;
    sdbg("unified tick loop created");

    const buildBody = (opts: { include: string[]; isFinal: boolean }) => {
      const currentSid = streamSidRef.current;
      const v = videoRef.current;
      const epoch = playbackEpochRef.current;
      const body: any = {
        sid: currentSid,
        epoch,
        include: opts.include,
        currentTime: v ? v.currentTime : 0,
        segmentIndex: -1, // server derives from currentTime if <0
      };
      if (opts.include.includes("heartbeat")) {
        heartbeatSeqRef.current += 1;
        body.seq = heartbeatSeqRef.current;
        body.nonce = (typeof crypto !== "undefined" && (crypto as any).randomUUID)
          ? (crypto as any).randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
        body.playbackRate = v ? (v.playbackRate || 1) : 1;
      }
      if (opts.include.includes("ping") && sessionCodeRef.current) {
        body.sessionCode = sessionCodeRef.current;
        body.secondsWatched = secondsWatchedRef.current;
      }
      if (opts.isFinal) body.final = true;
      return body;
    };

    const runTick = (opts?: { final?: boolean }) => {
      const currentSid = streamSidRef.current;
      if (!currentSid) return;
      const isFinal = !!opts?.final;
      const v = videoRef.current;

      tickCounterRef.current += 1;
      const n = tickCounterRef.current;

      const include: string[] = [];
      // Progress: skip if no meaningful position (rotation/seek in flight,
      // currentTime ≤ 0.25, or video ended). On final tick, still include
      // so analytics record the final position.
      const progressOk = !!v && !isRotatingRef.current && !isSeekingRef.current
        && v.currentTime > 0.25 && !videoEndedRef.current;
      if (isFinal || progressOk) include.push("progress");
      // Heartbeat every 2nd tick. Only when server hinted v2 (replay-safe).
      if (hardeningHintRef.current.v2 && (isFinal || n % 2 === 0)) include.push("heartbeat");
      // Ping every 3rd tick. Also on the very first tick so the server
      // mints a sessionCode immediately (replaces the old init /ping call).
      // When sessionCodeRef.current is null the server creates one and we
      // capture it from response.ping.sessionCode below.
      if (isFinal || n === 1 || n % 3 === 0) include.push("ping");

      if (include.length === 0) return;

      const body = buildBody({ include, isFinal });

      // Stale-epoch guard for progress (mirrors the previous progress loop).
      if (include.includes("progress") && body.epoch !== playbackEpochRef.current) {
        sdbg("tick progress skipped — stale epoch");
        // Strip progress but still send heartbeat/ping if requested.
        body.include = body.include.filter((s: string) => s !== "progress");
        if (body.include.length === 0) return;
      }

      // sendBeacon for unload-time delivery (fetch is killed mid-flight on
      // page teardown). Keep-alive fetch is the fallback for visibility:hidden
      // where the page is alive but may be backgrounded.
      if (isFinal && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        try {
          const blob = new Blob([JSON.stringify(body)], { type: "application/json" });
          const ok = navigator.sendBeacon(`/api/player/${publicId}/tick`, blob);
          if (ok) return;
        } catch {}
      }

      fetch(`/api/player/${publicId}/tick`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive: isFinal,
      }).then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          // Surface denial when server explicitly blocks. Token/session
          // expiry are recoverable and are handled by the HLS ERROR path.
          if (res.status === 403 && (data.code === "BLOCKED_SUSPICIOUS_ACTIVITY" || data.error === "VIDEO_BLOCKED")) {
            triggerDenial(data.signal || data.reason || "rate_limit");
          }
          return;
        }
        const data = await res.json().catch(() => null);
        // First /tick that includes a ping may mint a sessionCode — capture
        // it so subsequent ticks include secondsWatched against it.
        if (data?.ping?.sessionCode && !sessionCodeRef.current) {
          sessionCodeRef.current = data.ping.sessionCode;
          setSessionCode(data.ping.sessionCode);
        }
      }).catch(() => {});
    };

    tickIntervalRef.current = setInterval(() => {
      const v = videoRef.current;
      // Steady-state: only tick while playback is active. Heartbeat is then
      // pinned to playback — when the user pauses for >40s the session may
      // expire, which is caught and recovered by the HLS error path on resume.
      if (!v || v.paused) return;
      runTick();
    }, 20000);

    // Final-tick hooks. Coalesce repeated triggers via finalTickFiredRef so
    // we don't fire multiple beacons in quick succession (e.g. hidden then
    // pagehide within ms).
    const fireFinal = () => {
      if (finalTickFiredRef.current) return;
      finalTickFiredRef.current = true;
      runTick({ final: true });
      // Allow a follow-up final if the user comes back and leaves again.
      setTimeout(() => { finalTickFiredRef.current = false; }, 5000);
    };
    const onVisibility = () => { if (document.hidden) fireFinal(); };
    const onPageHide = () => fireFinal();

    // Expose fireFinal so the pause/ended handlers in a separate useEffect
    // can trigger an analytics flush without duplicating runTick logic.
    fireFinalTickRef.current = fireFinal;

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onPageHide);

    // Fire the very first tick immediately rather than waiting 20s — this
    // mints the analytics sessionCode right at startup (replacing the old
    // init /ping call) so secondsWatched starts accumulating from t=0.
    // Deferred to a microtask so HLS.loadSource() in the init effect runs
    // first; the tick itself is fire-and-forget and won't block playback.
    queueMicrotask(() => {
      if (!streamSidRef.current || !tickIntervalRef.current) return;
      runTick();
    });

    return () => {
      if (tickIntervalRef.current) {
        clearInterval(tickIntervalRef.current);
        tickIntervalRef.current = null;
        sdbg("unified tick loop cleared");
      }
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onPageHide);
      if (fireFinalTickRef.current === fireFinal) fireFinalTickRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicId, status]);

  // Forward client-side violation events to the server's security-event endpoint.
  // (Existing reportViolation() handles client-side counter/cooldown — this adds
  // server-side abuse scoring so persistent violators get the session revoked.)
  useEffect(() => {
    if (!publicId) return;
    const wrap = (handler: (ev: any) => void) => handler;
    const onRightClick = wrap((e: MouseEvent) => {
      if (e && (e.target as HTMLElement)?.closest?.("video")) {
        reportSecurityEvent(publicId, streamSidRef.current, "RIGHT_CLICK");
      }
    });
    document.addEventListener("contextmenu", onRightClick);
    return () => document.removeEventListener("contextmenu", onRightClick);
  }, [publicId]);

  // Cleanup MediaSource guard on unmount
  useEffect(() => {
    return () => {
      if (msGuardCleanupRef.current) {
        msGuardCleanupRef.current();
        msGuardCleanupRef.current = null;
      }
    };
  }, []);

  // ── MOUNT LIFECYCLE LOG ────────────────────────────────────────────
  // Emits a single MOUNT log on first render and a single UNMOUNT log on
  // teardown, both tagged with the per-instance mountId. If you ever see
  // TWO different mountIds posting to the same publicId at the same time
  // in the network panel, that confirms a duplicate iframe / double-include
  // on the host page — not a stale callback inside one instance.
  useEffect(() => {
    sdbg("MOUNT", { mountId: mountIdRef.current, publicId });
    return () => {
      sdbg("UNMOUNT", { mountId: mountIdRef.current, publicId });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pause video immediately when violation cooldown block is triggered
  useEffect(() => {
    if (isBlocked) {
      videoRef.current?.pause();
    }
  }, [isBlocked]);

  // Focus Mode — pause playback and report violation when window loses focus
  useEffect(() => {
    if (!effectiveSecurity.enableFocusMode) return;
    const onBlur = () => {
      videoRef.current?.pause();
      reportViolation("FOCUS_LOST" as ViolationType);
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        videoRef.current?.pause();
        reportViolation("FOCUS_LOST" as ViolationType);
      }
    };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveSecurity.enableFocusMode]);

  // DevTools detection — pauses playback when browser DevTools is open
  useEffect(() => {
    if (status !== "ready" && status !== "loading") return;
    if (effectiveSecurity.blockDevTools === false) return;

    // Threshold above normal browser chrome (address bar, etc. add ~50–80px)
    const WIDTH_THRESHOLD = 160;
    const HEIGHT_THRESHOLD = 200;

    // Secondary console-getter trick: V8 calls object getters when DevTools
    // console is actively rendering logged objects. We fire this silently by
    // passing a detached Image with a spoofed 'src' getter.
    const makeConsoleProbe = () => {
      let triggered = false;
      const img = new Image();
      Object.defineProperty(img, "src", {
        get() { triggered = true; return ""; },
      });
      // console.debug is less visible than console.log but still triggers the getter
      // when the DevTools console panel is open and rendering
      console.debug(img);
      return triggered;
    };

    const detect = () => {
      const wDiff = (window.outerWidth || 0) - (window.innerWidth || 0);
      const hDiff = (window.outerHeight || 0) - (window.innerHeight || 0);
      const sizeDetected = wDiff > WIDTH_THRESHOLD || hDiff > HEIGHT_THRESHOLD;
      const consoleDetected = makeConsoleProbe();
      return sizeDetected || consoleDetected;
    };

    const handleDetection = (open: boolean) => {
      if (open && !devToolsOpenRef.current) {
        devToolsOpenRef.current = true;
        videoRef.current?.pause();
        reportViolation("DEVTOOLS_DETECTED" as ViolationType);
      } else if (!open && devToolsOpenRef.current) {
        devToolsOpenRef.current = false;
        // Auto-resume if not server-blocked and not violation-blocked
        if (!denialSignalRef.current && !isBlocked) {
          videoRef.current?.play().catch(() => {});
        }
      }
    };

    // Poll every 500 ms
    devToolsCheckRef.current = setInterval(() => {
      handleDetection(detect());
    }, 500);

    // Also react immediately on window resize (docked/undocked DevTools)
    const onResize = () => handleDetection(detect());
    window.addEventListener("resize", onResize);

    return () => {
      if (devToolsCheckRef.current) clearInterval(devToolsCheckRef.current);
      window.removeEventListener("resize", onResize);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, effectiveSecurity.blockDevTools]);

  // Ticker animation
  useEffect(() => {
    if (!watermarkSettings.tickerEnabled) return;
    const speed = watermarkSettings.tickerSpeed || 50;
    const interval = setInterval(() => {
      setTickerOffset(prev => prev - (speed / 60));
    }, 16);
    return () => clearInterval(interval);
  }, [watermarkSettings.tickerEnabled, watermarkSettings.tickerSpeed]);

  // Banner ticker animation
  useEffect(() => {
    const tickerBanners = playerBanners.filter(b => b.type === "ticker" && b.enabled);
    if (tickerBanners.length === 0) return;
    const interval = setInterval(() => {
      setBannerTickerOffsets(prev => {
        const next = { ...prev };
        tickerBanners.forEach(b => {
          const speed = b.speed ?? 18;
          next[b.id] = (prev[b.id] ?? 0) - (speed / 60);
        });
        return next;
      });
    }, 16);
    return () => clearInterval(interval);
  }, [playerBanners]);

  // Pop watermark
  useEffect(() => {
    if (!watermarkSettings.popEnabled) return;
    const interval = (watermarkSettings.popInterval || 30) * 1000;
    popIntervalRef.current = setInterval(() => {
      const mode = watermarkSettings.popMode || "random";
      let pos: string;
      if (mode === "center") pos = POP_POSITIONS[4];
      else if (mode === "corners") pos = POP_POSITIONS[Math.floor(Math.random() * 4)];
      else pos = POP_POSITIONS[Math.floor(Math.random() * POP_POSITIONS.length)];
      setPopPosition(pos);
      setPopVisible(true);
      setTimeout(() => setPopVisible(false), (watermarkSettings.popDuration || 3) * 1000);
    }, interval);
    return () => { if (popIntervalRef.current) clearInterval(popIntervalRef.current); };
  }, [watermarkSettings.popEnabled, watermarkSettings.popInterval, watermarkSettings.popDuration, watermarkSettings.popMode]);

  // Video event handlers — depend on status so listeners attach when the video element enters the DOM
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => { setPlaying(true); lastPausedAtRef.current = -1; };
    const onPause = () => {
      setPlaying(false);
      lastPausedAtRef.current = Date.now();
      // P3: fire a final tick so analytics flush (secondsWatched + currentTime)
      // is recorded immediately on pause rather than waiting for the next 20s
      // tick — which may never fire if the user pauses then closes the tab.
      fireFinalTickRef.current?.();
    };
    const onEnded = () => {
      setPlaying(false);
      lastPausedAtRef.current = -1;
      // Mark the ended state so the periodic progress interval stops sending
      // the end-of-video segment index, which would leave the server window
      // parked at the last segment and cause 403s on replay from the start.
      videoEndedRef.current = true;
      // P3: final tick — record completion event in analytics.
      fireFinalTickRef.current?.();
    };
    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      if (!video.paused) setSecondsWatched(s => s + 0.25);
    };
    const onDuration = () => {
      const d = video.duration;
      // Once we have a valid duration, never let it go back to 0/NaN/Infinity.
      // This prevents the collapse bug during manifest reloads or quality switches.
      if (!isFinite(d) || d <= 0) return;
      setDuration(prev => {
        // If API already gave us a sensible duration within 5 seconds, keep it stable
        // (avoids flash when DB is already correct).
        const apiD = apiDurationRef.current;
        if (apiD > 0 && Math.abs(d - apiD) <= 5) return prev > 0 ? prev : d;
        // HLS wins when meaningfully different (DB was stale) — take the larger value
        // to avoid shrinkage from partial manifest loads.
        return Math.max(prev, d);
      });
    };
    const onVolumeChange = () => { setVolume(video.volume); setMuted(video.muted); };
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("durationchange", onDuration);
    video.addEventListener("volumechange", onVolumeChange);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("durationchange", onDuration);
      video.removeEventListener("volumechange", onVolumeChange);
    };
  }, [status]);

  // Controls auto-hide — 5s inactivity timer
  const showControlsTemporarily = useCallback(() => {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => setShowControls(false), 5000);
  }, []);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v || isBlocked || playbackDenied) return;
    // Fullscreen required — prompt fullscreen and count violation
    if (effectiveSecurity.requireFullscreen && !isFullscreen && v.paused) {
      enterFullscreen();
      reportViolation("FULLSCREEN_REQUIRED_BREACH" as ViolationType);
      return;
    }
    if (v.paused) {
      // ── REPLAY AFTER ENDED ──────────────────────────────────────────────
      // When the video has reached its natural end, `v.ended === true` and
      // `v.currentTime ≈ duration`. Calling `v.play()` at this position would
      // either replay the last few ms and immediately fire "ended" again, or
      // (on some browsers) silently do nothing. More importantly, the server
      // window is still parked at the last-segment index from the final
      // progress report. We must reset it before any HLS chunk requests arrive.
      // Fix: run the full seek-to-start flow through applyPendingSeek(0), which:
      //   1. increments playbackEpoch (via seekProgressWithTimeout → aborts stale in-flight)
      //   2. POSTs seekTo:true with currentTime=0 → server resets window to [0, windowSegs]
      //   3. calls hls.startLoad(0) → hls.js fetches from the beginning
      //   4. clears videoEndedRef so the progress interval resumes
      if (videoEndedRef.current || v.ended) {
        videoEndedRef.current = false;
        applyPendingSeek(0);
        return;
      }
      // If paused for more than 90 seconds, proactively rotate the HLS session
      // to get fresh signed URLs before resuming — prevents black-screen on long pauses.
      const pausedMs = lastPausedAtRef.current > 0 ? Date.now() - lastPausedAtRef.current : 0;
      if (pausedMs > 90_000) {
        const currentSid = streamSidRef.current;
        if (currentSid && publicId) {
          const savedTime = v.currentTime;
          fetch(`/api/player/${publicId}/rotate-session`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sid: currentSid, currentTime: savedTime }),
          })
            .then(r => r.ok ? r.json() : null)
            .then(data => {
              if (data?.manifestUrl && data?.sessionId) {
                streamSidRef.current = data.sessionId;
                const hls = hlsRef.current;
                if (hls) {
                  const opId = ++rotationOpIdRef.current;
                  isRotatingRef.current = true;
                  const nextUrl = (data.stealth && data.stealth.enabled && data.stealth.streamUrl) ? data.stealth.streamUrl : data.manifestUrl;
                  hls.loadSource(nextUrl);
                  const pauseSafetyTimer = setTimeout(() => {
                    if (opId !== rotationOpIdRef.current) return;
                    if (isRotatingRef.current) {
                      isRotatingRef.current = false;
                      const resumeAt = pendingMessageSeekRef.current ?? savedTime;
                      hls.stopLoad();
                      hls.startLoad(resumeAt);
                      v.currentTime = resumeAt;
                      v.play().catch(() => {});
                      // MANIFEST_PARSED never fired — re-anchor progress so
                      // the sliding window matches the resume position.
                      sendProgress("pause-resume", resumeAt, { sid: data.sessionId, seekTo: true });
                      if (pendingMessageSeekRef.current !== null) applyPendingSeek();
                    }
                  }, 15000);
                  hls.once(Hls.Events.MANIFEST_PARSED, () => {
                    clearTimeout(pauseSafetyTimer);
                    if (opId !== rotationOpIdRef.current) return;
                    isRotatingRef.current = false;
                    const resumeAt = pendingMessageSeekRef.current ?? savedTime;
                    hls.startLoad(resumeAt);
                    const doSeekAndPlay = () => {
                      try { v.currentTime = resumeAt; } catch {}
                      v.play().catch(() => {});
                    };
                    hls.once(Hls.Events.FRAG_BUFFERED, doSeekAndPlay);
                    if (pendingMessageSeekRef.current !== null) applyPendingSeek();
                    sendProgress("pause-resume", resumeAt, { sid: data.sessionId, seekTo: true });
                  });
                } else {
                  v.play().catch(() => {});
                }
              } else {
                v.play().catch(() => {});
              }
              lastPausedAtRef.current = -1;
            })
            .catch(() => {
              v.play().catch(() => {});
              lastPausedAtRef.current = -1;
            });
          return;
        }
      }
      v.play().catch(() => {});
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  };

  const reportProgressNow = (time: number) => {
    sendProgress("manual", time);
  };

  // Shared seek routine for local interactions (skip buttons, scrubber).
  //
  // OPTIMISTIC EXECUTION — first-click responsiveness for backward seeks.
  // Previous version awaited the pre-seek /progress POST before applying
  // v.currentTime + hls.startLoad. With the POST timeout race (up to 1s)
  // and any network blip, the user perceived the first click as a no-op
  // and had to click 2-3 times. The user's report explicitly described
  // this symptom for backward seeks.
  //
  // New flow:
  //  1. Apply v.currentTime = newTime IMMEDIATELY (instant visual jump).
  //  2. hls.stopLoad() + startLoad(newTime) IMMEDIATELY so HLS.js flushes
  //     its in-flight fragment queue and begins loading from the target.
  //  3. Fire the /progress POST in PARALLEL via seekProgressWithTimeout
  //     (which raises isSeekingRef so the periodic loop yields).
  //     - For backward seeks within already-exposed EVENT-playlist content
  //       no window advance is needed — segments are already in window.
  //     - For forward seeks beyond the window, the chunk request will get
  //       a 403 and the HLS error handler's seek-recovery branch will
  //       re-POST with seekTo:true and resume — no permanent freeze.
  //  4. Auto-resume play when canplay/playing fires (or immediately if
  //     buffer is already populated, e.g. small backward seek).
  //  5. Self-retry watchdog at 1.5s: if pendingSeekTargetRef still matches
  //     and the video is more than 2s away from target with low readyState,
  //     re-apply currentTime + startLoad + seek-recovery POST. One retry
  //     only — no infinite loop.
  //
  // Security invariants preserved: server still validates SID, EVENT
  // playlist still append-only, signed URLs unchanged, no client trust of
  // any unsigned data. Forward-seek scraping protection remains in place
  // (updateProgress caps forward jumps at earnedCeiling + SEEK_FORWARD_CAP).
  const performLocalSeek = (newTime: number) => {
    const v = videoRef.current;
    if (!v) return;
    const hls = hlsRef.current;
    const currentSid = streamSidRef.current;
    const wasPlaying = !v.paused;

    pendingSeekTargetRef.current = newTime;
    setCurrentTime(newTime);
    setIsBuffering(true);
    setBufferPct(0);
    lastSeekAtRef.current = Date.now();
    seekRecoveryCountRef.current = 0;
    sdbg("performLocalSeek — optimistic", { target: newTime, wasPlaying, fromTime: v.currentTime });

    // 1. Apply position + flush HLS IMMEDIATELY. Order matters: stopLoad
    //    first so HLS abandons the in-flight queue, then currentTime so
    //    MSE buffer-flush targets the new position, then startLoad so
    //    fetching resumes at the new offset.
    if (hls) { try { hls.stopLoad(); } catch {} }
    try { v.currentTime = newTime; } catch {}
    if (hls) { try { hls.startLoad(newTime); } catch {} }

    // 2. Fire-and-forget progress POST. seekProgressWithTimeout raises
    //    isSeekingRef and routes through sendProgress("seek", ...) — both
    //    of which the periodic loop's same-tick guard depends on.
    if (currentSid) {
      void seekProgressWithTimeout(currentSid, newTime);
    }

    // 3. Auto-resume playback when the new position is playable. Use
    //    once-listeners so they don't accumulate across rapid seeks.
    if (wasPlaying) {
      const tryPlay = () => { videoRef.current?.play().catch(() => {}); };
      v.addEventListener("canplay", tryPlay, { once: true });
      v.addEventListener("playing", tryPlay, { once: true });
      // Best-effort immediate play in case the new position is already
      // populated in the MSE source buffer (very small backward seek).
      tryPlay();
    }

    // 4. Self-retry watchdog. If the optimistic seek didn't take effect
    //    within 1.5s and the user hasn't issued a newer seek in the
    //    meantime, re-apply currentTime + startLoad once and post a
    //    seek-recovery progress so the server re-anchors its window.
    const retryTarget = newTime;
    setTimeout(() => {
      if (pendingSeekTargetRef.current !== retryTarget) return; // newer seek superseded
      const cur = videoRef.current;
      if (!cur) { pendingSeekTargetRef.current = null; return; }
      const stuck = Math.abs(cur.currentTime - retryTarget) > 2 && cur.readyState < 3;
      if (stuck) {
        sdbg("performLocalSeek — retry (stuck after 1.5s)", { target: retryTarget, actual: cur.currentTime, readyState: cur.readyState });
        const hlsNow = hlsRef.current;
        if (hlsNow) { try { hlsNow.stopLoad(); } catch {} }
        try { cur.currentTime = retryTarget; } catch {}
        if (hlsNow) { try { hlsNow.startLoad(retryTarget); } catch {} }
        const sidNow = streamSidRef.current;
        if (sidNow) {
          sendProgress("seek-recovery", retryTarget, { sid: sidNow, seekTo: true });
        }
        if (wasPlaying) cur.play().catch(() => {});
      } else {
        sdbg("performLocalSeek — landed", { target: retryTarget, actual: cur.currentTime, readyState: cur.readyState });
      }
      pendingSeekTargetRef.current = null;
    }, 1500);
  };

  const seek = (delta: number) => {
    const v = videoRef.current;
    if (!v || !playerSettings.allowSkip) return;
    const newTime = Math.max(0, Math.min(isFinite(v.duration) ? v.duration : Infinity, v.currentTime + delta));
    performLocalSeek(newTime);
  };

  const handleSeekBar = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v || !playerSettings.allowSkip) return;
    const newTime = parseFloat(e.target.value);
    performLocalSeek(newTime);
  };

  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    const vol = parseFloat(e.target.value);
    v.volume = vol;
    v.muted = vol === 0;
    setVolume(vol);
    setMuted(vol === 0);
  };

  const enterFullscreen = async () => {
    const el = playerContainerRef.current;
    const v = videoRef.current;
    if (!el) return;

    try {
      if (el.requestFullscreen) {
        await el.requestFullscreen();
        setIsFullscreen(true);
      } else if ((el as any).webkitRequestFullscreen) {
        (el as any).webkitRequestFullscreen();
        setIsFullscreen(true);
      } else if (v && (v as any).webkitEnterFullscreen) {
        (v as any).webkitEnterFullscreen();
        setIsFullscreen(true);
      } else {
        setIsFullscreen(true);
      }
    } catch {
      setIsFullscreen(true);
    }

    try {
      const orientation = screen.orientation as any;
      if (orientation?.lock) {
        await orientation.lock("landscape").catch(() => {});
      }
    } catch {}
  };

  const exitFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if ((document as any).webkitFullscreenElement) {
        (document as any).webkitCancelFullScreen();
      }
    } catch {}

    setIsFullscreen(false);

    try {
      const orientation = screen.orientation as any;
      if (orientation?.unlock) {
        orientation.unlock();
      } else if (orientation?.lock) {
        await orientation.lock("portrait").catch(() => {});
      }
    } catch {}
  };

  const toggleFullscreen = () => {
    if (!playerSettings.allowFullscreen) return;
    if (isFullscreen) {
      exitFullscreen();
    } else {
      enterFullscreen();
    }
  };

  useEffect(() => {
    const onFsChange = () => {
      const inNativeFs = !!(document.fullscreenElement || (document as any).webkitFullscreenElement);
      if (!inNativeFs && isFullscreen) {
        setIsFullscreen(false);
        try {
          const orientation = screen.orientation as any;
          if (orientation?.unlock) orientation.unlock();
        } catch {}
      }
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
      try {
        const orientation = screen.orientation as any;
        if (orientation?.unlock) orientation.unlock();
      } catch {}
    };
  }, [isFullscreen]);

  const changeSpeed = (rate: number) => {
    const v = videoRef.current;
    if (!v || !playerSettings.allowSpeed) return;
    v.playbackRate = rate;
    setPlaybackRate(rate);
  };

  const changeQuality = (index: number) => {
    const hls = hlsRef.current;
    if (!hls || !playerSettings.allowQuality) return;
    if (index === -1) {
      // Auto mode — re-enable ABR. Use currentLevel so it takes effect
      // immediately rather than waiting for the next segment boundary.
      hls.currentLevel = -1;
    } else {
      // Manual selection — switch at the next segment boundary (nextLevel)
      // so the current segment finishes cleanly before the level changes.
      // This prevents the brief freeze caused by an abrupt mid-segment switch.
      hls.nextLevel = index;
    }
    setCurrentQuality(index);
  };

  if (status === "waiting") {
    return (
      <div className="flex h-screen items-center justify-center bg-black text-white">
        <div className="text-center space-y-3 max-w-xs px-4">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/40 border-t-white mx-auto" />
          <p className="text-base font-medium">Waiting for LMS authorization...</p>
          <p className="text-xs opacity-40">This player is waiting for your learning platform to authorize playback.</p>
        </div>
      </div>
    );
  }

  if (status === "blocked") {
    return (
      <div className="flex h-screen items-center justify-center bg-black text-white">
        <div className="text-center space-y-3 max-w-xs px-4">
          <div className="text-4xl select-none">🔒</div>
          <p className="text-base font-semibold">Access Restricted</p>
          <p className="text-sm opacity-60">This video can only be played inside the LMS.</p>
        </div>
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div className="flex h-screen items-center justify-center bg-black text-white">
        <div className="text-center space-y-2">
          <div className="text-4xl">🔒</div>
          <p className="text-lg font-semibold">{errorMsg || "Video Unavailable"}</p>
          <p className="text-sm opacity-60">This video is not available for playback.</p>
        </div>
      </div>
    );
  }

  if (status === "processing") {
    return (
      <div className="flex h-screen items-center justify-center bg-black text-white">
        <div className="text-center space-y-3">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-white border-t-transparent mx-auto" />
          <p className="text-lg font-semibold">Processing Video</p>
          <p className="text-sm opacity-60">Your video is being ingested and converted to HLS. Please check back in a few minutes.</p>
        </div>
      </div>
    );
  }

  if (status === "error" && errorMsg === "SESSION_LIMIT") {
    const mintAndContinue = async () => {
      const lmsToken = receivedLmsTokenRef.current;
      const mintBody: Record<string, string> = {};
      if (lmsToken) mintBody.lmsLaunchToken = lmsToken;

      // Proactively revoke competing sessions before re-minting.
      // Use revoke-other-sessions if we have our own token, otherwise
      // use revoke-sessions-by-launch (LMS context with no prior token).
      if (activeTokenRef.current) {
        await fetch(`/api/player/${publicId}/revoke-other-sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentToken: activeTokenRef.current }),
        }).catch(() => {});
      } else if (lmsToken) {
        await fetch(`/api/player/${publicId}/revoke-sessions-by-launch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lmsLaunchToken: lmsToken }),
        }).catch(() => {});
      }

      const mintRes = await fetch(`/api/player/${publicId}/mint`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-client-instance": getClientInstanceId() },
        credentials: "include",
        body: JSON.stringify(mintBody),
      });
      if (mintRes.ok) {
        const d = await mintRes.json();
        activeTokenRef.current = d.token;
        setSessionLimitInfo(null);
        setErrorMsg("");
        setStatus("loading");
        setRetryKey(k => k + 1);
      }
    };

    return (
      <div className="flex h-screen items-center justify-center bg-black text-white">
        <div className="text-center space-y-4 max-w-sm px-6">
          <div className="text-5xl select-none">📺</div>
          <p className="text-lg font-semibold">Session Limit Reached</p>
          <p className="text-sm opacity-60">
            You are already watching this video in another tab or device. Only one active session is allowed at a time.
          </p>
          <div className="flex flex-col gap-2 pt-2">
            <button
              onClick={mintAndContinue}
              className="w-full px-5 py-2.5 rounded-md bg-white text-black text-sm font-semibold hover:bg-white/90 transition-colors"
              data-testid="button-end-other-session"
            >
              End Other Session &amp; Continue Here
            </button>
          </div>
          <p className="text-xs opacity-40 pt-1">
            Ending other sessions will immediately stop playback on those devices.
          </p>
        </div>
      </div>
    );
  }

  if (status === "error" && errorMsg === "SHARE_TOKEN_EXPIRED") {
    return (
      <div className="flex h-screen items-center justify-center bg-black text-white">
        <div className="text-center space-y-4 max-w-sm px-6">
          <div className="text-5xl select-none">🔗</div>
          <p className="text-lg font-semibold">Access Link Expired</p>
          <p className="text-sm opacity-60">
            This share link is no longer valid. Please contact the person who shared this video to get a new link.
          </p>
        </div>
      </div>
    );
  }

  if (status === "error" && errorMsg === "PREVIEW_TOKEN_EXPIRED") {
    return (
      <div className="flex h-screen items-center justify-center bg-black text-white">
        <div className="text-center space-y-4 max-w-sm px-6">
          <div className="text-5xl select-none">🔑</div>
          <p className="text-lg font-semibold">Preview Link Expired</p>
          <p className="text-sm opacity-60">
            This preview link has expired. Go back to the dashboard and open the video again to get a fresh link.
          </p>
          <button
            onClick={() => window.history.back()}
            className="w-full px-5 py-2.5 rounded-md bg-white text-black text-sm font-semibold hover:bg-white/90 transition-colors"
            data-testid="button-go-back"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex h-screen items-center justify-center bg-black text-white">
        <div className="text-center space-y-2 max-w-sm px-4">
          <div className="text-4xl">⚠️</div>
          <p className="text-lg font-semibold">Playback Error</p>
          <p className="text-sm opacity-60">{errorMsg || "Could not load video."}</p>
        </div>
      </div>
    );
  }

  const ws = watermarkSettings;
  const tickerText = resolveWatermarkText(ws.tickerText || "", videoId, sessionCode);

  // Layout constants for overlay stacking
  const CONTROL_BAR_H = 72;  // height of the bottom controls dock
  const TICKER_H = 32;        // approximate height of a ticker bar
  const controlsActive = showControls || !playing;
  const wmTickerActive = !!(ws.tickerEnabled && ws.tickerText);
  const bannerTickerActive = playerBanners.some(b => b.type === "ticker" && b.enabled && b.position === "bottom");
  const anyTickerAtBottom = wmTickerActive || bannerTickerActive;
  // Bottom offset for displayName/headline pills — above controls and ticker
  const pillBaseBottom = (controlsActive ? CONTROL_BAR_H : 0) + (anyTickerAtBottom ? TICKER_H + 4 : 0) + 8;
  const popText = resolveWatermarkText(ws.popText || "{DOMAIN}", videoId, sessionCode);

  return (
    <div className={`bg-black w-full h-screen flex items-center justify-center overflow-hidden ${isFullscreen ? "fixed inset-0 z-[99999]" : ""}`}>
      <div
        ref={playerContainerRef}
        className={`relative w-full h-full select-none ${isFullscreen ? "fixed inset-0 z-[99999] bg-black" : ""}`}
        onMouseMove={showControlsTemporarily}
        onMouseLeave={() => playing && setShowControls(false)}
        onClick={togglePlay}
        onContextMenu={effectiveSecurity.disableRightClick ? e => {
          e.preventDefault();
          reportViolation("RIGHT_CLICK" as ViolationType);
        } : undefined}
      >
          {/* Video Element */}
          <video
            ref={videoRef}
            className="w-full h-full object-contain"
            style={{ filter: `brightness(${brightness}%)` }}
            playsInline
            preload="metadata"
            poster={thumbnailUrl || undefined}
            controlsList={effectiveSecurity.disableDownloads ? "nodownload" : undefined}
            onContextMenu={effectiveSecurity.disableRightClick ? e => e.preventDefault() : undefined}
          />

          {/* Initial loading overlay (pre-ready) */}
          {status === "loading" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 gap-3" data-testid="overlay-initial-loading">
              <div className="h-10 w-10 animate-spin rounded-full border-2 border-white border-t-transparent" />
              <p className="text-white/80 text-xs tracking-wide">Preparing secure playback…</p>
            </div>
          )}

          {/* Inline buffering overlay (YouTube/Netflix-style) — shown while
              hls.js is filling buffers mid-playback (seek, stall, rotation). */}
          {status === "ready" && isBuffering && !isBlocked && (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 backdrop-blur-[1px] pointer-events-none z-30"
              data-testid="overlay-buffering"
            >
              <div className="relative h-14 w-14">
                <div className="absolute inset-0 animate-spin rounded-full border-[3px] border-white/20 border-t-white" />
              </div>
              {bufferPct > 0 && bufferPct < 100 && (
                <p className="mt-3 text-white/90 text-xs font-medium tracking-wide tabular-nums">
                  Buffering {bufferPct}%
                </p>
              )}
              {isRotatingRef.current && (
                <p className="mt-1 text-white/60 text-[10px] tracking-wide">
                  Reconnecting secure session…
                </p>
              )}
            </div>
          )}

          {/* Violation cooldown overlay — 10-minute block */}
          {isBlocked && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/90 z-50" data-testid="overlay-violation-blocked">
              <div className="text-center space-y-4 px-6 max-w-sm">
                <div className="text-5xl select-none">⏱️</div>
                <p className="text-white text-base font-semibold leading-snug">
                  Video access blocked
                </p>
                <p className="text-white/70 text-sm">
                  Too many security violations detected.
                </p>
                <p className="text-white text-2xl font-mono font-bold" data-testid="text-cooldown-timer">
                  {formatCountdown(remainingMs)}
                </p>
                <p className="text-white/50 text-xs">
                  Access will resume automatically when the timer ends.
                </p>
              </div>
            </div>
          )}

          {/* Violation popup — centered, red, prominent */}
          {violationToast && !isBlocked && (
            <div
              className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none"
              data-testid="toast-violation"
            >
              <div className="bg-red-600 rounded-xl px-8 py-6 text-center shadow-2xl border border-red-400/40 min-w-[220px] max-w-[80%]">
                <div className="text-2xl mb-2 select-none">🚨</div>
                <p className="text-white text-lg font-bold tracking-wide uppercase">Security Breach</p>
                <p className="text-white/90 text-base font-semibold mt-1">{violationToast.message}</p>
                <p className="text-white/65 text-xs mt-2">{violationToast.sub}</p>
              </div>
            </div>
          )}

          {/* Playback Denied overlay */}
          {playbackDenied && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/85 z-50" data-testid="overlay-playback-denied">
              <div className="text-center space-y-4 px-6 max-w-sm">
                <div className="text-5xl select-none">🛡️</div>
                <p className="text-white text-base font-semibold leading-snug">
                  Video playback denied due to suspicious activity.
                </p>
                <p className="text-white/60 text-sm">
                  {denialSignal === "devtools"
                    ? "Browser developer tools are open. Close DevTools to resume."
                    : denialSignal === "concurrent"
                    ? "Too many simultaneous connections were detected."
                    : denialSignal === "playlist_abuse"
                    ? "Excessive playlist requests were detected."
                    : denialSignal === "key_abuse"
                    ? "Excessive encryption key requests were detected."
                    : denialSignal === "ip_mismatch"
                    ? "Session used from multiple locations simultaneously."
                    : "Too many requests were detected. Please wait a moment and try again."}
                </p>
                {denialSignal !== "devtools" && (
                  <button
                    onClick={e => { e.stopPropagation(); retryPlayback(); }}
                    className="mt-2 px-5 py-2 rounded-md bg-white text-black text-sm font-medium hover:bg-white/90 transition-colors"
                    data-testid="button-retry-playback"
                  >
                    Retry
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Logo Watermark */}
          {ws.logoEnabled && ws.logoUrl && (
            <div
              className={`absolute pointer-events-none ${POSITION_CLASSES[ws.logoPosition || "top-right"]}`}
              style={{ opacity: ws.logoOpacity ?? 0.8 }}
            >
              <img src={ws.logoUrl} alt="" className="h-8 max-w-[120px] object-contain" />
            </div>
          )}

          {/* Ticker */}
          {ws.tickerEnabled && ws.tickerText && (
            <div
              className="absolute left-0 right-0 overflow-hidden pointer-events-none"
              style={{
                bottom: controlsActive ? CONTROL_BAR_H : 0,
                transition: "bottom 200ms ease",
                opacity: ws.tickerOpacity ?? 0.7,
              }}
            >
              <div
                className="whitespace-nowrap font-medium py-0.5 px-2"
                style={{
                  color: ws.tickerTextColor || "#FFFFFF",
                  fontSize: `${ws.tickerFontSizePx || 14}px`,
                  backgroundColor: ws.tickerBgColor ? `${ws.tickerBgColor}66` : "rgba(0,0,0,0.4)",
                  transform: `translateX(${tickerOffset % (tickerText.length * 12 + 800)}px)`,
                }}
              >
                {tickerText} &nbsp;&nbsp;&nbsp;&nbsp;{tickerText}
              </div>
            </div>
          )}

          {/* Author Name Overlay */}
          {ws.authorEnabled && (ws.authorName || videoId) && (
            <div
              className="absolute top-3 right-3 pointer-events-none px-3 py-1.5 rounded"
              style={{
                color: ws.authorTextColor || "#FFFFFF",
                fontSize: `${ws.authorFontSizePx || 14}px`,
                opacity: ws.authorOpacity ?? 0.8,
                backgroundColor: ws.authorBgColor && ws.authorBgColor !== "transparent" ? ws.authorBgColor : "transparent",
                fontWeight: (ws.authorTextStyle === "bold" || ws.authorTextStyle === "bold_italic") ? "bold" : "normal",
                fontStyle: (ws.authorTextStyle === "italic" || ws.authorTextStyle === "bold_italic") ? "italic" : "normal",
                zIndex: 30,
              }}
              data-testid="overlay-author-name"
            >
              {ws.authorName || ""}
            </div>
          )}

          {/* Pop Watermark */}
          {ws.popEnabled && popVisible && (
            <div
              className={`absolute pointer-events-none text-white text-sm font-semibold px-2 py-1 rounded bg-black/50 ${popPosition}`}
              style={{ opacity: ws.popOpacity ?? 0.8 }}
            >
              {popText}
            </div>
          )}

          {/* Controls Overlay — z-[10]; brand overlays use z-[15] to appear above */}
          <div
            className={`absolute inset-0 flex flex-col justify-end transition-opacity duration-300 z-[10] ${showControls || !playing ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
            onClick={e => e.stopPropagation()}
          >
            {/* Gradient backdrop */}
            <div className="absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-black/80 via-black/40 to-transparent pointer-events-none" />

            {/* Controls dock */}
            <div className="relative z-[1] mx-2 mb-2 sm:mx-3 sm:mb-3 rounded-xl bg-[#1a1a1f]/85 backdrop-blur-md border border-white/[0.08] shadow-[0_4px_24px_rgba(0,0,0,0.5)]">
              {/* Seek Bar — YouTube-style: dark track → light buffer → red played → thumb */}
              {(playerSettings.allowSkip !== false) && (
                <div className="px-3 pt-2.5 pb-0 group/seek">
                  <div className="relative w-full cursor-pointer" style={{ height: "12px" }}>
                    {/* Track rail */}
                    <div className="absolute inset-x-0 rounded-full bg-white/[0.12] transition-all duration-150"
                      style={{ height: "4px", top: "50%", transform: "translateY(-50%)" }}
                    >
                      {/* Buffer layer — light white, shows actual buffered range from video.buffered */}
                      <div
                        className="absolute inset-y-0 left-0 rounded-full bg-white/30"
                        style={{ width: `${bufferedEndPct}%` }}
                      />
                      {/* Played layer — brand red */}
                      <div
                        className="absolute inset-y-0 left-0 rounded-full bg-[#EF6A77]"
                        style={{ width: `${duration ? Math.min(100, (currentTime / duration) * 100) : 0}%` }}
                      />
                    </div>
                    {/* Thumb — appears on hover */}
                    <div
                      className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white shadow-[0_0_4px_rgba(0,0,0,0.5)] pointer-events-none opacity-0 group-hover/seek:opacity-100 transition-opacity duration-150"
                      style={{ left: `calc(${duration ? Math.min(100, (currentTime / duration) * 100) : 0}% - 6px)` }}
                    />
                    {/* Transparent range input — handles all mouse/touch interaction */}
                    <input
                      type="range"
                      min={0}
                      max={duration || 100}
                      step={0.1}
                      value={currentTime}
                      onChange={handleSeekBar}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      data-testid="input-seek-bar"
                    />
                  </div>
                </div>
              )}

              {/* Controls Bar */}
              <div className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-2 sm:py-2.5">
                {/* Play/Pause — primary action */}
                <button
                  onClick={togglePlay}
                  className="player-btn-primary group/play flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-[#EF6A77]/10 hover:bg-[#EF6A77]/25 active:bg-[#EF6A77]/35 text-white transition-all duration-200 shrink-0"
                  data-testid="button-play-pause"
                >
                  {playing ? (
                    <svg className="h-4 w-4 sm:h-[18px] sm:w-[18px] fill-current drop-shadow-sm" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                  ) : (
                    <svg className="h-4 w-4 sm:h-[18px] sm:w-[18px] fill-current drop-shadow-sm ml-0.5" viewBox="0 0 24 24"><polygon points="6,3 20,12 6,21"/></svg>
                  )}
                </button>

                {/* Skip -10 / +10 */}
                {playerSettings.allowSkip !== false && (
                  <>
                    <button
                      onClick={() => seek(-10)}
                      className="player-btn flex items-center justify-center w-7 h-7 sm:w-8 sm:h-8 rounded-lg text-white/70 hover:text-white hover:bg-white/10 active:bg-white/15 transition-all duration-200 shrink-0"
                      data-testid="button-skip-back"
                    >
                      <span className="text-[10px] sm:text-xs font-semibold tracking-tight">-10</span>
                    </button>
                    <button
                      onClick={() => seek(10)}
                      className="player-btn flex items-center justify-center w-7 h-7 sm:w-8 sm:h-8 rounded-lg text-white/70 hover:text-white hover:bg-white/10 active:bg-white/15 transition-all duration-200 shrink-0"
                      data-testid="button-skip-forward"
                    >
                      <span className="text-[10px] sm:text-xs font-semibold tracking-tight">+10</span>
                    </button>
                  </>
                )}

                {/* Time */}
                <span className="text-white/60 text-[10px] sm:text-xs shrink-0 font-mono tracking-tight tabular-nums ml-0.5" data-testid="text-time-display">
                  <span className="text-white/90">{formatTime(currentTime)}</span>
                  <span className="mx-0.5 text-white/30">/</span>
                  <span>{formatTime(duration)}</span>
                </span>

                <div className="flex-1 min-w-2" />

                {/* Volume */}
                <div className="flex items-center gap-0.5 group/vol">
                  <button
                    onClick={() => { const v = videoRef.current; if (v) { v.muted = !v.muted; setMuted(v.muted); } }}
                    className="player-btn flex items-center justify-center w-7 h-7 sm:w-8 sm:h-8 rounded-lg text-white/70 hover:text-white hover:bg-white/10 active:bg-white/15 transition-all duration-200"
                    data-testid="button-mute"
                  >
                    {muted || volume === 0 ? (
                      <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
                    ) : (
                      <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
                    )}
                  </button>
                  <input
                    type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume}
                    onChange={handleVolume}
                    className="player-slider w-0 group-hover/vol:w-16 sm:w-14 sm:group-hover/vol:w-20 h-1 cursor-pointer transition-all duration-300 rounded-full overflow-hidden"
                    style={{
                      background: `linear-gradient(to right, #EF6A77 0%, #EF6A77 ${(muted ? 0 : volume) * 100}%, rgba(255,255,255,0.2) ${(muted ? 0 : volume) * 100}%, rgba(255,255,255,0.2) 100%)`,
                    }}
                    data-testid="input-volume"
                  />
                </div>

                {/* Brightness */}
                {playerSettings.allowBrightness !== false && (
                  <div className="flex items-center gap-0.5 group/brt">
                    <button className="player-btn flex items-center justify-center w-7 h-7 sm:w-8 sm:h-8 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-all duration-200 cursor-default" title="Brightness" data-testid="button-brightness">
                      <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24"><path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58a.996.996 0 00-1.41 0 .996.996 0 000 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37a.996.996 0 00-1.41 0 .996.996 0 000 1.41l1.06 1.06c.39.39 1.03.39 1.41 0a.996.996 0 000-1.41l-1.06-1.06zm1.06-10.96a.996.996 0 000-1.41.996.996 0 00-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36a.996.996 0 000-1.41.996.996 0 00-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z"/></svg>
                    </button>
                    <input
                      type="range" min={30} max={150} step={5} value={brightness}
                      onChange={e => setBrightness(parseInt(e.target.value))}
                      className="player-slider w-0 group-hover/brt:w-16 sm:w-0 sm:group-hover/brt:w-16 h-1 cursor-pointer transition-all duration-300 rounded-full overflow-hidden"
                      style={{
                        background: `linear-gradient(to right, #4FB1C1 0%, #4FB1C1 ${((brightness - 30) / 120) * 100}%, rgba(255,255,255,0.2) ${((brightness - 30) / 120) * 100}%, rgba(255,255,255,0.2) 100%)`,
                      }}
                      title="Brightness"
                      data-testid="input-brightness"
                    />
                  </div>
                )}

                {/* Divider */}
                <div className="hidden sm:block w-px h-5 bg-white/10 mx-0.5" />

                {/* Speed */}
                {playerSettings.allowSpeed !== false && (
                  <select
                    value={playbackRate}
                    onChange={e => changeSpeed(parseFloat(e.target.value))}
                    className="player-select bg-white/[0.06] hover:bg-white/[0.12] text-white/80 hover:text-white text-[10px] sm:text-xs rounded-lg px-1.5 sm:px-2 py-1 sm:py-1.5 border border-white/[0.08] hover:border-white/[0.15] transition-all duration-200 cursor-pointer outline-none appearance-none font-medium"
                    data-testid="select-speed"
                  >
                    {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].map(r => (
                      <option key={r} value={r}>{r}x</option>
                    ))}
                  </select>
                )}

                {/* Quality */}
                {playerSettings.allowQuality !== false && qualities.length > 1 && (
                  <select
                    value={currentQuality}
                    onChange={e => changeQuality(parseInt(e.target.value))}
                    className="player-select bg-white/[0.06] hover:bg-white/[0.12] text-white/80 hover:text-white text-[10px] sm:text-xs rounded-lg px-1.5 sm:px-2 py-1 sm:py-1.5 border border-white/[0.08] hover:border-white/[0.15] transition-all duration-200 cursor-pointer outline-none appearance-none font-medium"
                    data-testid="select-quality"
                  >
                    <option value={-1}>Auto</option>
                    {qualities.map(q => <option key={q.index} value={q.index}>{q.height}p</option>)}
                  </select>
                )}

                {/* Fullscreen */}
                {playerSettings.allowFullscreen !== false && (
                  <button
                    onClick={toggleFullscreen}
                    className="player-btn flex items-center justify-center w-7 h-7 sm:w-8 sm:h-8 rounded-lg text-white/70 hover:text-white hover:bg-white/10 active:bg-white/15 transition-all duration-200"
                    data-testid="button-fullscreen"
                  >
                    {isFullscreen ? (
                      <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>
                    ) : (
                      <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* ── Brand Overlays (z-[15] — above controls gradient) ── */}

          {/* Full Overlay Image */}
          {playerSettings.overlayEnabled && playerSettings.overlayUrl && (() => {
            const mode = playerSettings.overlayMode ?? "full";
            const styleMap: Record<string, React.CSSProperties> = {
              full:   { inset: 0 },
              top:    { top: 0, left: 0, right: 0, height: "30%" },
              bottom: { bottom: 0, left: 0, right: 0, height: "30%" },
              left:   { top: 0, bottom: 0, left: 0, width: "30%" },
              right:  { top: 0, bottom: 0, right: 0, width: "30%" },
            };
            return (
              <div
                className="absolute pointer-events-none z-[15]"
                style={{ ...styleMap[mode] ?? styleMap.full, opacity: playerSettings.overlayOpacity ?? 0.6 }}
                data-testid="overlay-player-overlay"
              >
                <img src={playerSettings.overlayUrl} alt="" className="w-full h-full object-cover" />
              </div>
            );
          })()}

          {/* Logo */}
          {playerSettings.logoEnabled && playerSettings.logoUrl && (() => {
            const pos: Record<string, React.CSSProperties> = {
              "top-left":     { top: 12, left: 12 },
              "top-right":    { top: 12, right: 12 },
              "bottom-left":  { bottom: 52, left: 12 },
              "bottom-right": { bottom: 52, right: 12 },
            };
            const sizePercent = playerSettings.logoSizePercent ?? 12;
            return (
              <div
                className="absolute pointer-events-none z-[15]"
                style={{ ...pos[playerSettings.logoPlacement ?? "top-right"] ?? pos["top-right"], opacity: playerSettings.logoOpacity ?? 0.9, width: `${sizePercent}%` }}
                data-testid="overlay-player-logo"
              >
                <img src={playerSettings.logoUrl} alt="" className="w-full h-auto object-contain" />
              </div>
            );
          })()}

          {/* QR Code */}
          {playerSettings.qrEnabled && playerSettings.qrDataUrl && (() => {
            const pos: Record<string, React.CSSProperties> = {
              "top-left":     { top: 12, left: 12 },
              "top-right":    { top: 12, right: 12 },
              "bottom-left":  { bottom: 52, left: 12 },
              "bottom-right": { bottom: 52, right: 12 },
            };
            const sizePercent = playerSettings.qrSizePercent ?? 14;
            return (
              <div
                className="absolute pointer-events-none rounded-lg overflow-hidden z-[15]"
                style={{
                  ...pos[playerSettings.qrPlacement ?? "bottom-right"] ?? pos["bottom-right"],
                  opacity: playerSettings.qrOpacity ?? 1,
                  width: `${sizePercent}%`,
                  backgroundColor: playerSettings.qrBgEnabled ? `rgba(0,0,0,${playerSettings.qrBgOpacity ?? 0.5})` : "transparent",
                  padding: playerSettings.qrBgEnabled ? "6px" : 0,
                }}
                data-testid="overlay-player-qr"
              >
                <img src={playerSettings.qrDataUrl} alt={playerSettings.qrTitle ?? "QR Code"} className="w-full h-auto block" />
                {playerSettings.qrTitle && (
                  <p className="text-white text-center text-[10px] mt-0.5 leading-tight truncate">
                    {playerSettings.qrTitle}
                  </p>
                )}
              </div>
            );
          })()}

          {/* Display Name & Headline Text Overlays — pill style, stacks above ticker + controls */}
          {(() => {
            const dnEnabled = playerSettings.showDisplayNames && playerSettings.displayNameText;
            const hlEnabled = playerSettings.showHeadlines && playerSettings.headlineText;
            const dnPos = playerSettings.displayNamePosition ?? "bottom-left";
            const hlPos = playerSettings.headlinePosition ?? "bottom-left";
            const dnFontSize = playerSettings.displayNameFontSize ?? 18;
            const hlFontSize = playerSettings.headlineFontSize ?? 18;
            // If both on same side, stack them: headline at base, displayName above it
            const sameSide = dnPos === hlPos;
            const hlBottom = pillBaseBottom;
            const dnBottom = hlBottom + (hlEnabled && sameSide ? hlFontSize + 24 : 0);
            const makePillStyle = (
              bgEnabled: boolean | undefined,
              bgColor: string | undefined,
              bgOpacity: number | undefined,
              textColor: string | undefined,
              fontSize: number,
              bottom: number,
              pos: string,
            ): React.CSSProperties => ({
              position: "absolute",
              bottom,
              ...(pos === "bottom-left" ? { left: 16 } : { right: 16 }),
              display: "inline-block",
              padding: "6px 12px",
              borderRadius: 8,
              backgroundColor: bgEnabled !== false
                ? `rgba(${parseInt((bgColor ?? "#000000").slice(1,3),16)},${parseInt((bgColor ?? "#000000").slice(3,5),16)},${parseInt((bgColor ?? "#000000").slice(5,7),16)},${bgOpacity ?? 0.35})`
                : "transparent",
              color: textColor ?? "#ffffff",
              fontSize,
              fontFamily: playerSettings.fontFamily ?? "inherit",
              maxWidth: "55%",
              whiteSpace: "nowrap" as const,
              overflow: "hidden",
              textOverflow: "ellipsis",
              transition: "bottom 200ms ease",
              zIndex: 15,
            });
            return (
              <>
                {hlEnabled && (
                  <div
                    className="pointer-events-none"
                    style={makePillStyle(
                      playerSettings.headlineBgEnabled,
                      playerSettings.headlineBgColor,
                      playerSettings.headlineBgOpacity,
                      playerSettings.headlineTextColor,
                      hlFontSize,
                      hlBottom,
                      hlPos,
                    )}
                    data-testid="overlay-headline"
                  >
                    {playerSettings.headlineText}
                  </div>
                )}
                {dnEnabled && (
                  <div
                    className="pointer-events-none"
                    style={makePillStyle(
                      playerSettings.displayNameBgEnabled,
                      playerSettings.displayNameBgColor,
                      playerSettings.displayNameBgOpacity,
                      playerSettings.displayNameTextColor,
                      dnFontSize,
                      dnBottom,
                      dnPos,
                    )}
                    data-testid="overlay-display-name"
                  >
                    {playerSettings.displayNameText}
                  </div>
                )}
              </>
            );
          })()}

          {/* Banners & Tickers */}
          {playerBanners.map(banner => {
            const isTicker = banner.type === "ticker";
            const isTop = banner.position === "top";
            const bannerBottom = isTicker && !isTop ? (controlsActive ? CONTROL_BAR_H : 0) : 0;
            const posStyle: React.CSSProperties = isTop
              ? { top: 0, left: 0, right: 0 }
              : { bottom: bannerBottom, left: 0, right: 0, transition: "bottom 200ms ease" };
            const bgColor = banner.backgroundColor ?? "#0b3a66";
            const textColor = banner.textColor ?? "#ffffff";
            const fontSize = banner.fontSize ?? 18;
            const opacity = banner.opacity ?? 1;
            const paddingY = banner.paddingY ?? 8;
            const paddingX = banner.paddingX ?? 14;
            const offset = bannerTickerOffsets[banner.id] ?? 0;
            const textLen = banner.text.length;
            const wrapAt = textLen * (fontSize * 0.65) + 400;
            return (
              <div
                key={banner.id}
                className="absolute overflow-hidden pointer-events-none z-[15]"
                style={{ ...posStyle, backgroundColor: bgColor, opacity, paddingTop: paddingY, paddingBottom: paddingY }}
                data-testid={`overlay-banner-${banner.id}`}
              >
                {isTicker ? (
                  <div
                    className="whitespace-nowrap"
                    style={{
                      color: textColor,
                      fontSize: `${fontSize}px`,
                      paddingLeft: paddingX,
                      paddingRight: paddingX,
                      transform: `translateX(${offset % wrapAt}px)`,
                      display: "inline-block",
                    }}
                  >
                    {banner.text}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{banner.text}
                  </div>
                ) : (
                  <div
                    className="text-center"
                    style={{ color: textColor, fontSize: `${fontSize}px`, paddingLeft: paddingX, paddingRight: paddingX }}
                  >
                    {banner.text}
                  </div>
                )}
              </div>
            );
          })}

        </div>
    </div>
  );
}
