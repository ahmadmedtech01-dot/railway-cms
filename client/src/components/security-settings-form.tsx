import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";

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
};

export const defaultClientSecuritySettings: ClientSecuritySettings = {
  blockVideoRecording: false,
  blockScreenshots: false,
  disableRightClick: false,
  blockDevTools: true,
  enableFocusMode: false,
  disableDownloads: false,
  requireFullscreen: false,
  antiScreenSharing: false,
  violationLimit: 3,
  allowedBrowsers: [],
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

const TOGGLES: { key: keyof ClientSecuritySettings; label: string; desc: string }[] = [
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

export function SecuritySettingsForm({ value, onChange, disabled, onSave, showSaveButton, isPending }: SecuritySettingsFormProps) {
  const [browserInput, setBrowserInput] = useState("");

  const set = <K extends keyof ClientSecuritySettings>(key: K, val: ClientSecuritySettings[K]) => {
    onChange({ ...value, [key]: val });
  };

  const addBrowser = () => {
    const trimmed = browserInput.trim().toLowerCase();
    if (!trimmed || value.allowedBrowsers.includes(trimmed)) return;
    set("allowedBrowsers", [...value.allowedBrowsers, trimmed]);
    setBrowserInput("");
  };

  return (
    <div className="space-y-1">
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

      <SettingRow label="Violation Limit" description="Number of violations before playback is blocked">
        <Input
          type="number"
          min={1}
          max={20}
          value={value.violationLimit}
          onChange={e => set("violationLimit", parseInt(e.target.value) || 3)}
          disabled={disabled}
          className="w-20 text-center"
          data-testid="input-violation-limit"
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
