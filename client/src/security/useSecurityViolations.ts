import { useState, useRef, useEffect, useCallback } from "react";

export type ViolationType =
  | "DEVTOOLS_DETECTED"
  | "RIGHT_CLICK"
  | "DOWNLOAD_ATTEMPT"
  | "SCREENSHOT_SUSPECTED"
  | "SCREEN_RECORD_SUSPECTED"
  | "SCREEN_SHARING_DETECTED"
  | "FOCUS_LOST"
  | "FULLSCREEN_REQUIRED_BREACH";

const EVENT_LABELS: Record<ViolationType, string> = {
  DEVTOOLS_DETECTED: "Developer tools opened",
  RIGHT_CLICK: "Right-click attempt blocked",
  DOWNLOAD_ATTEMPT: "Download attempt blocked",
  SCREENSHOT_SUSPECTED: "Screenshot suspected",
  SCREEN_RECORD_SUSPECTED: "Screen recording suspected",
  SCREEN_SHARING_DETECTED: "Screen sharing detected",
  FOCUS_LOST: "Focus lost during playback",
  FULLSCREEN_REQUIRED_BREACH: "Fullscreen required",
};

interface ViolationState {
  count: number;
  blockedUntil: number;
  lastEventAt: number;
  lastEventType: string;
}

export interface ViolationToast {
  message: string;
  sub: string;
  isBlock: boolean;
}

const BLOCK_DURATION_MS = 10 * 60 * 1000;
const DEBOUNCE_MS = 3_000;
const EMPTY_STATE: ViolationState = { count: 0, blockedUntil: 0, lastEventAt: 0, lastEventType: "" };

function lsKey(videoId: string) {
  return `sec:violations:anon:${videoId}`;
}

function readState(videoId: string): ViolationState {
  if (!videoId) return { ...EMPTY_STATE };
  try {
    const raw = localStorage.getItem(lsKey(videoId));
    if (raw) return { ...EMPTY_STATE, ...JSON.parse(raw) };
  } catch {}
  return { ...EMPTY_STATE };
}

function writeState(videoId: string, s: ViolationState) {
  if (!videoId) return;
  try { localStorage.setItem(lsKey(videoId), JSON.stringify(s)); } catch {}
}

export function useSecurityViolations(
  videoId: string,
  settings: Record<string, any>,
  options?: { disabled?: boolean },
) {
  const disabled = options?.disabled ?? false;
  const limit: number = Math.max(1, settings?.violationLimit ?? 20);

  // Use a ref as authoritative source to avoid stale closures
  const stateRef = useRef<ViolationState>(readState(videoId));
  const [state, setStateRaw] = useState<ViolationState>(stateRef.current);
  const lastEventTsRef = useRef<Partial<Record<ViolationType, number>>>({});
  const [toast, setToast] = useState<ViolationToast | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const syncState = (next: ViolationState) => {
    stateRef.current = next;
    writeState(videoId, next);
    setStateRaw(next);
  };

  // Reload from storage when videoId is resolved (starts as "")
  useEffect(() => {
    if (!videoId) return;
    const s = readState(videoId);
    syncState(s);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  // Countdown timer — runs always, clears cooldown when time expires
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const s = stateRef.current;
      if (s.blockedUntil > 0 && s.blockedUntil <= now) {
        syncState({ ...EMPTY_STATE });
      } else if (s.blockedUntil > now) {
        // Force re-render to update the countdown display
        setStateRaw(prev => ({ ...prev }));
      }
    }, 1000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  const showToast = useCallback((msg: ViolationToast) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => setToast(null), 4_000);
  }, []);

  const reportViolation = useCallback((eventType: ViolationType) => {
    if (disabled) return;
    const now = Date.now();
    const current = stateRef.current;

    // Already in cooldown — do not increment
    if (current.blockedUntil > now) return;

    // Debounce per event type
    const lastTs = lastEventTsRef.current[eventType] ?? 0;
    if (now - lastTs < DEBOUNCE_MS) return;
    lastEventTsRef.current[eventType] = now;

    const newCount = current.count + 1;
    const willBlock = newCount >= limit;
    const newBlockedUntil = willBlock ? now + BLOCK_DURATION_MS : 0;

    syncState({
      count: newCount,
      blockedUntil: newBlockedUntil,
      lastEventAt: now,
      lastEventType: eventType,
    });

    const label = EVENT_LABELS[eventType] ?? eventType;
    showToast({
      message: willBlock ? `Blocked: ${newCount}/${limit} violations reached` : `Security breach ${newCount}/${limit}`,
      sub: label,
      isBlock: willBlock,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, videoId, limit, showToast]);

  const isBlocked = !disabled && state.blockedUntil > Date.now();
  const remainingMs = disabled ? 0 : Math.max(0, state.blockedUntil - Date.now());

  return {
    reportViolation,
    isBlocked,
    remainingMs,
    count: disabled ? 0 : state.count,
    limit,
    toast: disabled ? null : toast,
    clearToast: () => setToast(null),
  };
}

export function formatCountdown(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}
