import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useSearch } from "wouter";
import Hls from "hls.js";
import { useSecurityViolations, formatCountdown } from "@/security/useSecurityViolations";
import type { ViolationType } from "@/security/useSecurityViolations";

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

export default function EmbedPlayerPage() {
  const { publicId } = useParams<{ publicId: string }>();
  const search = useSearch();
  const urlParams = new URLSearchParams(search);
  // Only accept ?token= for admin preview tokens (adminPreview:true JWT).
  // LMS tokens must arrive via postMessage — never via URL.
  const urlToken = urlParams.get("token") || "";

  const activeTokenRef = useRef(urlToken);
  const token = urlToken;
  const receivedLmsTokenRef = useRef<string | null>(null);
  const lmsOriginsRef = useRef<string[]>([]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const progressIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const popIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const rotationIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const controlsTimerRef = useRef<NodeJS.Timeout | null>(null);
  const devToolsCheckRef = useRef<NodeJS.Timeout | null>(null);
  const devToolsOpenRef = useRef(false);
  const streamSidRef = useRef("");
  const denialSignalRef = useRef("");
  const effectiveSecurityRef = useRef<Record<string, any>>({ blockDevTools: true });

  const [status, setStatus] = useState<"waiting" | "blocked" | "loading" | "ready" | "error" | "unavailable" | "processing">(
    urlToken ? "loading" : "waiting"
  );
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
  // Disabled entirely for admin preview and when suspiciousDetectionEnabled is off
  const { reportViolation, isBlocked, remainingMs, toast: violationToast } =
    useSecurityViolations(videoId, effectiveSecurity, {
      disabled: isAdminPreview || !securityReady || effectiveSecurity?.suspiciousDetectionEnabled === false,
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
    hlsRef.current?.destroy();
    hlsRef.current = null;
    setStatus("loading");
    setRetryKey(k => k + 1);
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
    if (urlToken) return; // admin preview token in URL — skip iframe enforcement

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
      receivedLmsTokenRef.current = msg.token;
      setStatus("loading");
      setRetryKey(k => k + 1);
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicId, urlToken]);

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
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify(mintBody),
          });
          if (mintRes.status === 429) {
            const d = await mintRes.json().catch(() => ({}));
            if (d.code === "SESSION_LIMIT") {
              setSessionLimitInfo({ activeSessions: d.activeSessions || [] });
              setStatus("error");
              setErrorMsg("SESSION_LIMIT");
              return;
            }
          }
          if (!mintRes.ok) {
            const d = await mintRes.json().catch(() => ({}));
            setStatus("error");
            setErrorMsg(d.message || "Could not start session");
            return;
          }
          const mintData = await mintRes.json();
          activeToken = mintData.token;
          activeTokenRef.current = activeToken;
        }

        // Fetch manifest
        const qs = activeToken ? `?token=${encodeURIComponent(activeToken)}` : "";
        const referrer = document.referrer;
        const manifestRes = await fetch(`/api/player/${publicId}/manifest${qs}`, {
          headers: referrer ? { "x-embed-referrer": referrer } : {},
        });

        if (manifestRes.status === 202) {
          setStatus("processing");
          return;
        }

        if (!manifestRes.ok) {
          const data = await manifestRes.json().catch(() => ({}));
          if (manifestRes.status === 503) { setStatus("unavailable"); return; }
          if (manifestRes.status === 403) { setStatus("unavailable"); setErrorMsg(data.message || "Access denied"); return; }
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
        const resolvedVideoId = data.videoId || "";
        setVideoId(resolvedVideoId);
        if (data.adminPreview === true) setIsAdminPreview(true);
        if (data.videoDuration && data.videoDuration > 0) setDuration(data.videoDuration);

        // Fetch video settings and effective security in parallel
        await Promise.allSettled([
          fetch(`/api/player/${publicId}/settings${qs}`).then(async r => {
            if (r.ok) {
              const s = await r.json();
              setPlayerSettings(s.playerSettings || {});
              setWatermarkSettings(s.watermarkSettings || {});
              if (s.thumbnailUrl) setThumbnailUrl(s.thumbnailUrl);
              if (s.videoDuration && s.videoDuration > 0) setDuration(s.videoDuration);
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

        // Start session ping
        const pingRes = await fetch(`/api/player/${publicId}/ping`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(referrer ? { "x-embed-referrer": referrer } : {}) },
          body: JSON.stringify({}),
        });
        if (pingRes.ok) {
          const pingData = await pingRes.json();
          if (pingData.sessionCode) setSessionCode(pingData.sessionCode);
        }

        const manifestUrl = data.manifestUrl;
        if (!manifestUrl) { setStatus("error"); setErrorMsg("No manifest URL"); return; }
        if (data.sessionId) streamSidRef.current = data.sessionId;

        if (!videoRef.current) return;
        const video = videoRef.current;

        if (Hls.isSupported()) {
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            liveSyncDurationCount: 99,
            liveMaxLatencyDurationCount: Infinity,
            maxBufferLength: 30,
          });
          hlsRef.current = hls;
          hls.loadSource(manifestUrl);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, (_, hlsData) => {
            setQualities(hlsData.levels.map((l, i) => ({ height: l.height, index: i })));
            setStatus("ready");
            if (playerSettings.autoplayAllowed) video.play().catch(() => {});
          });
          hls.on(Hls.Events.LEVEL_LOADED, (_, d) => {
            const total = d.details?.totalduration;
            if (total && isFinite(total) && total > 0) setDuration(prev => prev > 0 ? prev : total);
          });
          hls.on(Hls.Events.ERROR, (_, d) => {
            if (d.fatal) {
              const code = (d as any).response?.code;
              const responseText = (d as any).response?.text || "";
              if (code === 403 || code === 401) {
                hls.stopLoad();
                videoRef.current?.pause();
                let signal = "rate_limit";
                let errorCode = "";
                try {
                  const parsed = JSON.parse(responseText);
                  if (parsed?.signal) signal = parsed.signal;
                  if (parsed?.code) errorCode = parsed.code;
                } catch {}

                const isExpiry = errorCode === "TOKEN_EXPIRED" || errorCode === "SIGNED_URL_EXPIRED" || signal === "token_expired" || signal === "signed_url_expired";
                const isBulkBlock = errorCode === "SECURITY_BULK_DOWNLOAD" || signal === "rate_limit" || signal === "key_abuse";
                const canRefresh = activeTokenRef.current && isExpiry && !isBulkBlock;
                if (canRefresh) {
                  const savedTime = videoRef.current?.currentTime || 0;
                  fetch(`/api/player/${publicId}/refresh-token`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token: activeTokenRef.current }),
                  }).then(async r => {
                    if (!r.ok) { triggerDenial(signal); return; }
                    const rd = await r.json();
                    if (rd.token) activeTokenRef.current = rd.token;
                    if (rd.manifestUrl) {
                      hls.loadSource(rd.manifestUrl);
                      hls.once(Hls.Events.MANIFEST_PARSED, () => {
                        if (videoRef.current) {
                          videoRef.current.currentTime = savedTime;
                          videoRef.current.play().catch(() => {});
                        }
                      });
                    } else {
                      triggerDenial(signal);
                    }
                  }).catch(() => triggerDenial(signal));
                } else {
                  triggerDenial(signal);
                }
              } else if (code === 404) {
                // 404 means origin storage file not found — not a security issue
                let parsedCode = "";
                try { parsedCode = JSON.parse(responseText)?.code ?? ""; } catch {}
                if (parsedCode === "ORIGIN_PLAYLIST_NOT_FOUND") {
                  setStatus("error");
                  setErrorMsg("Stream source not found. Video processing may be incomplete or the storage path is missing.");
                } else {
                  setStatus("error");
                  setErrorMsg("Stream error");
                }
              } else {
                setStatus("error");
                setErrorMsg("Stream error");
              }
            }
          });
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = manifestUrl;
          video.addEventListener("loadedmetadata", () => setStatus("ready"));
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
    };
  }, [publicId, token, retryKey]);

  // Ping interval
  useEffect(() => {
    if (!sessionCode) return;
    pingIntervalRef.current = setInterval(() => {
      fetch(`/api/player/${publicId}/ping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionCode, secondsWatched }),
      }).catch(() => {});
    }, 30000);
    return () => { if (pingIntervalRef.current) clearInterval(pingIntervalRef.current); };
  }, [sessionCode, secondsWatched, publicId]);

  // Progress reporting for sliding window — every 15 seconds
  useEffect(() => {
    const sid = streamSidRef.current;
    if (!sid || !publicId) return;
    progressIntervalRef.current = setInterval(() => {
      const v = videoRef.current;
      if (!v || v.paused) return;
      fetch(`/api/stream/${publicId}/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sid, currentTime: v.currentTime }),
      }).catch(() => {});
    }, 10000);
    return () => { if (progressIntervalRef.current) clearInterval(progressIntervalRef.current); };
  }, [publicId, status]);

  // Session rotation — rotate every 3 minutes to invalidate old session and ephemeral key
  useEffect(() => {
    const sid = streamSidRef.current;
    if (!sid || !publicId) return;
    rotationIntervalRef.current = setInterval(async () => {
      const currentSid = streamSidRef.current;
      if (!currentSid) return;
      try {
        const res = await fetch(`/api/player/${publicId}/rotate-session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sid: currentSid }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!data.manifestUrl || !data.sessionId) return;
        streamSidRef.current = data.sessionId;
        const hls = hlsRef.current;
        if (hls) {
          const v = videoRef.current;
          const savedTime = v ? v.currentTime : 0;
          const wasPaused = v ? v.paused : true;
          hls.loadSource(data.manifestUrl);
          hls.once(Hls.Events.MANIFEST_PARSED, () => {
            if (v) {
              v.currentTime = savedTime;
              if (!wasPaused) v.play().catch(() => {});
            }
          });
        }
      } catch {}
    }, 3 * 60 * 1000);
    return () => { if (rotationIntervalRef.current) clearInterval(rotationIntervalRef.current); };
  }, [publicId, status]);

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

  // Video event handlers
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      if (playing) setSecondsWatched(s => s + 0.25);
    };
    const onDuration = () => {
      if (isFinite(video.duration) && video.duration > 0) setDuration(video.duration);
    };
    const onVolumeChange = () => { setVolume(video.volume); setMuted(video.muted); };
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("durationchange", onDuration);
    video.addEventListener("volumechange", onVolumeChange);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("durationchange", onDuration);
      video.removeEventListener("volumechange", onVolumeChange);
    };
  }, [playing]);

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
    if (effectiveSecurity.requireFullscreen && !document.fullscreenElement && v.paused) {
      playerContainerRef.current?.requestFullscreen().catch(() => {});
      reportViolation("FULLSCREEN_REQUIRED_BREACH" as ViolationType);
      return;
    }
    if (v.paused) v.play().catch(() => {}); else v.pause();
  };

  const reportProgressNow = (time: number) => {
    const sid = streamSidRef.current;
    if (!sid || !publicId) return;
    fetch(`/api/stream/${publicId}/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sid, currentTime: time }),
    }).catch(() => {});
  };

  const seek = (delta: number) => {
    const v = videoRef.current;
    if (!v || !playerSettings.allowSkip) return;
    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + delta));
    reportProgressNow(v.currentTime);
  };

  const handleSeekBar = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v || !playerSettings.allowSkip) return;
    v.currentTime = parseFloat(e.target.value);
    reportProgressNow(v.currentTime);
  };

  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    const vol = parseFloat(e.target.value);
    v.volume = vol;
    v.muted = vol === 0;
  };

  const toggleFullscreen = () => {
    if (!playerSettings.allowFullscreen) return;
    const el = playerContainerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen().then(() => setIsFullscreen(true));
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false));
    }
  };

  const changeSpeed = (rate: number) => {
    const v = videoRef.current;
    if (!v || !playerSettings.allowSpeed) return;
    v.playbackRate = rate;
    setPlaybackRate(rate);
  };

  const changeQuality = (index: number) => {
    const hls = hlsRef.current;
    if (!hls || !playerSettings.allowQuality) return;
    hls.currentLevel = index;
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
    const endOtherAndContinue = async () => {
      if (!activeTokenRef.current) return;
      const resp = await fetch(`/api/player/${publicId}/revoke-other-sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentToken: activeTokenRef.current }),
      });
      if (resp.ok) {
        setSessionLimitInfo(null);
        setErrorMsg("");
        setStatus("loading");
        setRetryKey(k => k + 1);
      }
    };

    const mintAndContinue = async () => {
      const mintBody: Record<string, string> = {};
      const lmsToken = receivedLmsTokenRef.current;
      if (lmsToken) mintBody.lmsLaunchToken = lmsToken;

      const mintRes = await fetch(`/api/player/${publicId}/mint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(mintBody),
      });
      if (mintRes.status === 429) {
        const d = await mintRes.json().catch(() => ({}));
        if (d.code === "SESSION_LIMIT") {
          if (activeTokenRef.current) {
            await endOtherAndContinue();
          }
        }
        return;
      }
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
  const CONTROL_BAR_H = 60;  // height of the bottom controls bar
  const TICKER_H = 32;        // approximate height of a ticker bar
  const controlsActive = showControls || !playing;
  const wmTickerActive = !!(ws.tickerEnabled && ws.tickerText);
  const bannerTickerActive = playerBanners.some(b => b.type === "ticker" && b.enabled && b.position === "bottom");
  const anyTickerAtBottom = wmTickerActive || bannerTickerActive;
  // Bottom offset for displayName/headline pills — above controls and ticker
  const pillBaseBottom = (controlsActive ? CONTROL_BAR_H : 0) + (anyTickerAtBottom ? TICKER_H + 4 : 0) + 8;
  const popText = resolveWatermarkText(ws.popText || "{DOMAIN}", videoId, sessionCode);

  return (
    <div className="bg-black w-full h-screen flex items-center justify-center overflow-hidden">
      <div
        ref={playerContainerRef}
        className="relative w-full h-full select-none"
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

          {/* Loading overlay */}
          {status === "loading" && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/80">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-white border-t-transparent" />
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
            className={`absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/70 via-transparent to-transparent transition-opacity duration-300 z-[10] ${showControls || !playing ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
            onClick={e => e.stopPropagation()}
          >
            {/* Seek Bar */}
            {(playerSettings.allowSkip !== false) && (
              <div className="px-3 pb-1">
                <input
                  type="range"
                  min={0}
                  max={duration || 100}
                  step={0.1}
                  value={currentTime}
                  onChange={handleSeekBar}
                  className="w-full h-1 cursor-pointer accent-white"
                />
              </div>
            )}

            {/* Controls Bar */}
            <div className="flex items-center gap-2 px-3 pb-3 flex-wrap">
              {/* Play/Pause */}
              <button onClick={togglePlay} className="text-white hover:text-white/80 shrink-0 p-1">
                {playing ? (
                  <svg className="h-5 w-5 fill-current" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                ) : (
                  <svg className="h-5 w-5 fill-current" viewBox="0 0 24 24"><polygon points="5,3 19,12 5,21"/></svg>
                )}
              </button>

              {/* Skip -10 */}
              {playerSettings.allowSkip !== false && (
                <>
                  <button onClick={() => seek(-10)} className="text-white text-xs hover:text-white/80 shrink-0 p-1">-10</button>
                  <button onClick={() => seek(10)} className="text-white text-xs hover:text-white/80 shrink-0 p-1">+10</button>
                </>
              )}

              {/* Time */}
              <span className="text-white text-xs shrink-0">{formatTime(currentTime)} / {formatTime(duration)}</span>

              <div className="flex-1" />

              {/* Volume */}
              <div className="flex items-center gap-1">
                <button onClick={() => { const v = videoRef.current; if (v) v.muted = !v.muted; }} className="text-white p-1">
                  {muted || volume === 0 ? (
                    <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
                  ) : (
                    <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
                  )}
                </button>
                <input
                  type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume}
                  onChange={handleVolume}
                  className="w-16 h-1 cursor-pointer accent-white"
                />
              </div>

              {/* Brightness */}
              {playerSettings.allowBrightness !== false && (
                <input
                  type="range" min={30} max={150} step={5} value={brightness}
                  onChange={e => setBrightness(parseInt(e.target.value))}
                  className="w-16 h-1 cursor-pointer accent-white"
                  title="Brightness"
                />
              )}

              {/* Speed */}
              {playerSettings.allowSpeed !== false && (
                <select
                  value={playbackRate}
                  onChange={e => changeSpeed(parseFloat(e.target.value))}
                  className="bg-black/60 text-white text-xs rounded px-1 py-0.5 border border-white/20"
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
                  className="bg-black/60 text-white text-xs rounded px-1 py-0.5 border border-white/20"
                >
                  <option value={-1}>Auto</option>
                  {qualities.map(q => <option key={q.index} value={q.index}>{q.height}p</option>)}
                </select>
              )}

              {/* Fullscreen */}
              {playerSettings.allowFullscreen !== false && (
                <button onClick={toggleFullscreen} className="text-white hover:text-white/80 p-1">
                  {isFullscreen ? (
                    <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>
                  ) : (
                    <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
                  )}
                </button>
              )}
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
