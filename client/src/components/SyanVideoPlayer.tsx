import { useEffect, useRef } from "react";

interface SyanVideoPlayerProps {
  publicId: string;
  launchToken?: string;
  embedToken?: string;
  cmsBase?: string;
  autoplay?: boolean;
  controls?: boolean;
  muted?: boolean;
  startAt?: number;
  poster?: string;
  className?: string;
  style?: React.CSSProperties;
  onReady?: () => void;
  onPlay?: () => void;
  onPause?: () => void;
  onTimeUpdate?: (data: { currentTime: number; duration: number }) => void;
  onSeek?: (data: { currentTime: number }) => void;
  onEnded?: () => void;
  onComplete?: () => void;
  onError?: (error: { code: string; message: string }) => void;
  onSessionExpired?: (error: any) => void;
}

export default function SyanVideoPlayer(props: SyanVideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);

  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    if (!containerRef.current) return;

    const loadAndMount = async () => {
      const p = propsRef.current;
      const base = p.cmsBase || "";

      const scriptId = "syan-player-sdk";
      let existing = document.getElementById(scriptId) as HTMLScriptElement | null;
      if (!existing) {
        existing = document.createElement("script");
        existing.id = scriptId;
        existing.src = `${base}/sdk/player.js`;
        document.head.appendChild(existing);
      }
      if (!(window as any).SyanPlayer) {
        await new Promise<void>((resolve, reject) => {
          const check = () => { if ((window as any).SyanPlayer) { resolve(); return; } };
          check();
          existing!.addEventListener("load", check);
          existing!.addEventListener("error", () => reject(new Error("Failed to load SyanPlayer SDK")));
          setTimeout(() => reject(new Error("SyanPlayer SDK load timeout")), 10000);
        });
      }

      const SyanPlayer = (window as any).SyanPlayer;
      if (!SyanPlayer) {
        p.onError?.({ code: "SDK_LOAD_FAILED", message: "SyanPlayer SDK not available" });
        return;
      }

      playerRef.current = SyanPlayer.mount({
        element: containerRef.current!,
        publicId: p.publicId,
        launchToken: p.launchToken,
        embedToken: p.embedToken,
        cmsBase: base,
        autoplay: p.autoplay,
        controls: p.controls,
        muted: p.muted,
        startAt: p.startAt,
        poster: p.poster,
        onReady: p.onReady,
        onPlay: p.onPlay,
        onPause: p.onPause,
        onTimeUpdate: p.onTimeUpdate,
        onSeek: p.onSeek,
        onEnded: p.onEnded,
        onComplete: p.onComplete,
        onError: p.onError,
        onSessionExpired: p.onSessionExpired,
      });
    };

    loadAndMount();

    return () => {
      if (playerRef.current) {
        playerRef.current.destroy();
        playerRef.current = null;
      }
    };
  }, [props.publicId, props.launchToken, props.embedToken]);

  return (
    <div
      ref={containerRef}
      className={props.className}
      style={{ width: "100%", height: "100%", background: "#000", ...props.style }}
      data-testid="syan-video-player"
    />
  );
}
