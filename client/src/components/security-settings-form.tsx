import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState } from "react";
import {
  SECURITY_PROFILES,
  SECURITY_PROFILE_LABELS,
  SECURITY_PROFILE_DESCRIPTIONS,
  DEFAULT_SECURITY_PROFILE,
  detectProfile,
  type SecurityProfileId,
} from "@shared/securityProfiles";

export type ClientSecuritySettings = {
  blockVideoRecording: boolean;
  blockScreenshots: boolean;
  disableRightClick: boolean;
  blockDevTools: boolean;
  enableFocusMode: boolean;
  disableDownloads: boolean;
  requireFullscreen: boolean;
  antiScreenSharing: boolean;
  violationLimit: number;
  allowedBrowsers: string[];
  suspiciousDetectionEnabled?: boolean;
  // Advanced hardening
  mediaSourceGuardEnabled?: boolean;
  velocityScoringEnabled?: boolean;
  keyBindingEnabled?: boolean;
  heartbeatV2Enabled?: boolean;
  serverGatedWindowEnabled?: boolean;
  shortTokenTtlEnabled?: boolean;
  stealthModeEnabled?: boolean;
  tokenTtlPlaylistSec?: number;
  tokenTtlSegmentSec?: number;
  tokenTtlKeySec?: number;
  heartbeatIntervalSec?: number;
  downloadAheadLimit?: number;
  // Security Profile (preset + time-based tuning)
  securityProfile?: SecurityProfileId;
  maxPrebufferSec?: number;
  maxDownloadAheadSec?: number;
  windowOverlapGraceSec?: number;
  // Session limits
  concurrentLimit?: number;
};

const BALANCED = SECURITY_PROFILES.balanced;

export const defaultClientSecuritySettings: ClientSecuritySettings = {
  blockVideoRecording: false,
  blockScreenshots: false,
  disableRightClick: false,
  blockDevTools: true,
  enableFocusMode: false,
  disableDownloads: false,
  requireFullscreen: false,
  antiScreenSharing: false,
  violationLimit: BALANCED.violationLimit,
  allowedBrowsers: [],
  suspiciousDetectionEnabled: true,
  mediaSourceGuardEnabled: true,
  velocityScoringEnabled: true,
  keyBindingEnabled: true,
  heartbeatV2Enabled: true,
  serverGatedWindowEnabled: false,
  shortTokenTtlEnabled: false,
  tokenTtlPlaylistSec: BALANCED.playlistTtlSec,
  tokenTtlSegmentSec: BALANCED.segmentTtlSec,
  tokenTtlKeySec: BALANCED.keyTtlSec,
  heartbeatIntervalSec: BALANCED.heartbeatIntervalSec,
  downloadAheadLimit: Math.ceil(BALANCED.maxDownloadAheadSec / 2),
  stealthModeEnabled: false,
  concurrentLimit: 5,
  securityProfile: DEFAULT_SECURITY_PROFILE,
  maxPrebufferSec: BALANCED.maxPrebufferSec,
  maxDownloadAheadSec: BALANCED.maxDownloadAheadSec,
  windowOverlapGraceSec: BALANCED.windowOverlapGraceSec,
};

function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-border last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

const HARDENING_TOGGLES: { key: keyof ClientSecuritySettings; label: string; desc: string }[] = [
  { key: "stealthModeEnabled", label: "Stealth Protected Playback Mode", desc: "Hide HLS file names (.m3u8 / .ts / /key / master / index / seg_*) from the browser Network tab using opaque per-session URLs. Adds a layer over existing security." },
  { key: "mediaSourceGuardEnabled", label: "MediaSource/appendBuffer Guard", desc: "Detect CocoCut-style hooks that wrap MediaSource or SourceBuffer.appendBuffer." },
  { key: "velocityScoringEnabled", label: "Download Velocity Scoring", desc: "Revoke sessions when too many segments are fetched per second (bulk download)." },
  { key: "keyBindingEnabled", label: "Stronger Key Binding", desc: "Bind AES-128 keys to session + progress + time (rate limited)." },
  { key: "heartbeatV2Enabled", label: "Strong Heartbeat (v2)", desc: "Use monotonic seq + nonce heartbeat every N seconds instead of the legacy 3-min extend." },
  { key: "serverGatedWindowEnabled", label: "Server-Gated Playlist Window", desc: "Only show a small live-window of segments; playlist advances ONLY on verified heartbeats. May break seeking on some players." },
  { key: "shortTokenTtlEnabled", label: "Short Token TTLs", desc: "Shorten signed segment/playlist/key TTLs so leaked URLs expire fast. Can cause more 403s on slow networks." },
];

const TOGGLES: { key: keyof ClientSecuritySettings; label: string; desc: string }[] = [
  { key: "suspiciousDetectionEnabled", label: "Suspicious Activity Detection", desc: "Blocks bulk-download patterns (parallel segment scraping, key spamming). Turn off if it blocks normal users." },
  { key: "blockDevTools", label: "Block DevTools", desc: "Pause playback when browser developer tools are detected" },
  { key: "disableRightClick", label: "Disable Right-Click", desc: "Prevent context menu on the video player" },
  { key: "disableDownloads", label: "Disable Downloads", desc: "Block native browser download actions" },
  { key: "blockVideoRecording", label: "Block Screen Recording", desc: "Attempt to detect and block screen recording software" },
  { key: "blockScreenshots", label: "Block Screenshots", desc: "Attempt to obscure content during screenshot capture" },
  { key: "antiScreenSharing", label: "Anti Screen Sharing", desc: "Detect and block screen sharing sessions" },
  { key: "enableFocusMode", label: "Focus Mode", desc: "Pause video when the player loses focus" },
  { key: "requireFullscreen", label: "Require Fullscreen", desc: "Only allow playback in fullscreen mode" },
];

interface SecuritySettingsFormProps {
  value: ClientSecuritySettings;
  onChange: (v: ClientSecuritySettings) => void;
  disabled?: boolean;
  onSave?: () => void;
  showSaveButton?: boolean;
  isPending?: boolean;
}

// Keys whose values define the active profile. Editing any of these flips the
// profile to "custom" automatically so the admin's tuning isn't silently
// overwritten on the next save.
const PROFILE_TUNED_KEYS: (keyof ClientSecuritySettings)[] = [
  "heartbeatIntervalSec",
  "tokenTtlPlaylistSec",
  "tokenTtlSegmentSec",
  "tokenTtlKeySec",
  "maxPrebufferSec",
  "maxDownloadAheadSec",
  "windowOverlapGraceSec",
  "violationLimit",
];

export function SecuritySettingsForm({ value, onChange, disabled, onSave, showSaveButton, isPending }: SecuritySettingsFormProps) {
  const [browserInput, setBrowserInput] = useState("");

  const set = <K extends keyof ClientSecuritySettings>(key: K, val: ClientSecuritySettings[K]) => {
    const next = { ...value, [key]: val };
    // Auto-flip to custom when a tuned value is edited directly.
    if (PROFILE_TUNED_KEYS.includes(key) && (value.securityProfile ?? DEFAULT_SECURITY_PROFILE) !== "custom") {
      next.securityProfile = "custom";
    }
    onChange(next);
  };

  const applyProfile = (id: SecurityProfileId) => {
    if (id === "custom") {
      onChange({ ...value, securityProfile: "custom" });
      return;
    }
    const p = SECURITY_PROFILES[id];
    onChange({
      ...value,
      securityProfile: id,
      heartbeatIntervalSec: p.heartbeatIntervalSec,
      tokenTtlPlaylistSec: p.playlistTtlSec,
      tokenTtlSegmentSec: p.segmentTtlSec,
      tokenTtlKeySec: p.keyTtlSec,
      maxPrebufferSec: p.maxPrebufferSec,
      maxDownloadAheadSec: p.maxDownloadAheadSec,
      windowOverlapGraceSec: p.windowOverlapGraceSec,
      violationLimit: p.violationLimit,
      // Keep downloadAheadLimit (segments) in sync with maxDownloadAheadSec
      // assuming ~2s segments — matches server-side derivation.
      downloadAheadLimit: Math.ceil(p.maxDownloadAheadSec / 2),
    });
  };

  const addBrowser = () => {
    const trimmed = browserInput.trim().toLowerCase();
    if (!trimmed || value.allowedBrowsers.includes(trimmed)) return;
    set("allowedBrowsers", [...value.allowedBrowsers, trimmed]);
    setBrowserInput("");
  };

  const activeProfile: SecurityProfileId = value.securityProfile
    ?? detectProfile({
      heartbeatIntervalSec: value.heartbeatIntervalSec,
      playlistTtlSec: value.tokenTtlPlaylistSec,
      segmentTtlSec: value.tokenTtlSegmentSec,
      keyTtlSec: value.tokenTtlKeySec,
      maxPrebufferSec: value.maxPrebufferSec,
      maxDownloadAheadSec: value.maxDownloadAheadSec,
      windowOverlapGraceSec: value.windowOverlapGraceSec,
      violationLimit: value.violationLimit,
    });

  return (
    <div className="space-y-1">
      {/* ── Security Profile (preset selector) ────────────────────────────── */}
      <div className="pb-3">
        <p className="text-sm font-semibold text-foreground">Security Profile</p>
        <p className="text-xs text-muted-foreground mb-3">
          Choose a preset tuned for your LMS concurrency and network conditions. Switch to
          <span className="font-medium text-foreground"> Custom </span>
          to edit every value below independently.
        </p>
        <Select
          value={activeProfile}
          onValueChange={(v) => applyProfile(v as SecurityProfileId)}
          disabled={disabled}
        >
          <SelectTrigger className="w-full max-w-md" data-testid="select-security-profile">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="compatibility" data-testid="option-profile-compatibility">{SECURITY_PROFILE_LABELS.compatibility}</SelectItem>
            <SelectItem value="balanced" data-testid="option-profile-balanced">{SECURITY_PROFILE_LABELS.balanced} (Recommended)</SelectItem>
            <SelectItem value="strict" data-testid="option-profile-strict">{SECURITY_PROFILE_LABELS.strict}</SelectItem>
            <SelectItem value="custom" data-testid="option-profile-custom">{SECURITY_PROFILE_LABELS.custom}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground mt-2">{SECURITY_PROFILE_DESCRIPTIONS[activeProfile]}</p>
      </div>

      <div className="pt-4 pb-2 border-t border-border">
        <p className="text-sm font-semibold text-foreground">Advanced Hardening</p>
        <p className="text-xs text-muted-foreground">Anti-downloader defenses. Safe defaults are on; gated playlist + short TTLs are optional.</p>
      </div>
      {HARDENING_TOGGLES.map(({ key, label, desc }) => (
        <SettingRow key={key} label={label} description={desc}>
          <Switch
            checked={!!value[key]}
            onCheckedChange={v => set(key as any, v as any)}
            disabled={disabled}
            data-testid={`switch-client-${key}`}
          />
        </SettingRow>
      ))}

      <SettingRow label="Heartbeat Interval (sec)" description="How often the player pings the server. Lower = faster revocation but more traffic.">
        <Input type="number" min={5} max={120} value={value.heartbeatIntervalSec ?? BALANCED.heartbeatIntervalSec}
          onChange={e => set("heartbeatIntervalSec", parseInt(e.target.value) || BALANCED.heartbeatIntervalSec)}
          disabled={disabled} className="w-24 text-center" data-testid="input-heartbeat-interval" />
      </SettingRow>
      <SettingRow label="Max Prebuffer (sec)" description="How far ahead the player may prefetch. Higher = smoother on slow networks; lower = tighter window.">
        <Input type="number" min={10} max={300} value={value.maxPrebufferSec ?? BALANCED.maxPrebufferSec}
          onChange={e => set("maxPrebufferSec", parseInt(e.target.value) || BALANCED.maxPrebufferSec)}
          disabled={disabled} className="w-24 text-center" data-testid="input-max-prebuffer" />
      </SettingRow>
      <SettingRow label="Max Download-Ahead (sec)" description="Max seconds of video fetchable in a 5s burst before velocity scoring trips.">
        <Input type="number" min={10} max={600} value={value.maxDownloadAheadSec ?? BALANCED.maxDownloadAheadSec}
          onChange={e => set("maxDownloadAheadSec", parseInt(e.target.value) || BALANCED.maxDownloadAheadSec)}
          disabled={disabled} className="w-24 text-center" data-testid="input-max-download-ahead" />
      </SettingRow>
      <SettingRow label="Window Overlap Grace (sec)" description="Grace period where out-of-window segment requests don't score abuse (covers seeks + quality switches).">
        <Input type="number" min={5} max={300} value={value.windowOverlapGraceSec ?? BALANCED.windowOverlapGraceSec}
          onChange={e => set("windowOverlapGraceSec", parseInt(e.target.value) || BALANCED.windowOverlapGraceSec)}
          disabled={disabled} className="w-24 text-center" data-testid="input-window-overlap-grace" />
      </SettingRow>
      <SettingRow label="Token TTL — Playlist (sec)" description="Lifetime of signed playlist URLs.">
        <Input type="number" min={15} max={600} value={value.tokenTtlPlaylistSec ?? BALANCED.playlistTtlSec}
          onChange={e => set("tokenTtlPlaylistSec", parseInt(e.target.value) || BALANCED.playlistTtlSec)}
          disabled={disabled} className="w-24 text-center" data-testid="input-ttl-playlist" />
      </SettingRow>
      <SettingRow label="Token TTL — Segment (sec)" description="Lifetime of signed segment (.ts) URLs.">
        <Input type="number" min={15} max={600} value={value.tokenTtlSegmentSec ?? BALANCED.segmentTtlSec}
          onChange={e => set("tokenTtlSegmentSec", parseInt(e.target.value) || BALANCED.segmentTtlSec)}
          disabled={disabled} className="w-24 text-center" data-testid="input-ttl-segment" />
      </SettingRow>
      <SettingRow label="Token TTL — Key (sec)" description="Lifetime of signed AES-128 key URLs.">
        <Input type="number" min={15} max={600} value={value.tokenTtlKeySec ?? BALANCED.keyTtlSec}
          onChange={e => set("tokenTtlKeySec", parseInt(e.target.value) || BALANCED.keyTtlSec)}
          disabled={disabled} className="w-24 text-center" data-testid="input-ttl-key" />
      </SettingRow>

      <div className="pt-4 pb-2 border-t border-border">
        <p className="text-sm font-semibold text-foreground">Client-Side Protection</p>
      </div>
      {TOGGLES.map(({ key, label, desc }) => (
        <SettingRow key={key} label={label} description={desc}>
          <Switch
            checked={!!value[key]}
            onCheckedChange={v => set(key as any, v as any)}
            disabled={disabled}
            data-testid={`switch-client-${key}`}
          />
        </SettingRow>
      ))}

      <SettingRow label="Violation Limit" description="Number of client-side violations before playback is blocked.">
        <Input
          type="number"
          min={1}
          max={50}
          value={value.violationLimit}
          onChange={e => set("violationLimit", parseInt(e.target.value) || BALANCED.violationLimit)}
          disabled={disabled}
          className="w-24 text-center"
          data-testid="input-violation-limit"
        />
      </SettingRow>

      <SettingRow label="Concurrent Session Limit" description="Max simultaneous active sessions per student. 5 is safe for browser refreshes. Raise for shared devices.">
        <Input
          type="number"
          min={1}
          max={20}
          value={value.concurrentLimit ?? 5}
          onChange={e => set("concurrentLimit", parseInt(e.target.value) || 5)}
          disabled={disabled}
          className="w-24 text-center"
          data-testid="input-concurrent-limit"
        />
      </SettingRow>

      <div className="pt-3">
        <Label className="text-sm font-medium">Allowed Browsers</Label>
        <p className="text-xs text-muted-foreground mb-2">Leave empty to allow all browsers</p>
        {!disabled && (
          <div className="flex gap-2 mb-2">
            <Input
              value={browserInput}
              onChange={e => setBrowserInput(e.target.value)}
              placeholder="chrome, firefox, safari…"
              onKeyDown={e => e.key === "Enter" && addBrowser()}
              data-testid="input-allowed-browser"
            />
            <Button variant="outline" onClick={addBrowser} data-testid="button-add-browser">Add</Button>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {value.allowedBrowsers.length === 0
            ? <p className="text-xs text-muted-foreground">All browsers allowed</p>
            : value.allowedBrowsers.map(b => (
              <Badge key={b} variant="secondary" className="gap-1.5">
                {b}
                {!disabled && (
                  <button
                    onClick={() => set("allowedBrowsers", value.allowedBrowsers.filter(x => x !== b))}
                    className="hover:text-destructive"
                    data-testid={`button-remove-browser-${b}`}
                  >×</button>
                )}
              </Badge>
            ))
          }
        </div>
      </div>

      {showSaveButton && onSave && (
        <div className="pt-4">
          <Button onClick={onSave} disabled={disabled || isPending} data-testid="button-save-client-security">
            {isPending ? "Saving…" : "Save Protection Settings"}
          </Button>
        </div>
      )}
    </div>
  );
}
