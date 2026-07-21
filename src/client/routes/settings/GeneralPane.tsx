import { useEffect, useState, type ReactNode } from "react";
import { Info, Moon, RotateCcw, Sun } from "lucide-react";
import type { StorageCleanupResponse, StorageStatusResponse } from "@shared/api-contracts";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@/lib/api-paths";
import { isDesktopRuntime } from "@/lib/runtime";
import { useUIStore, type Theme } from "@/store/ui";
import {
  buildAgentsPatch,
  buildWebAccessPatch,
  compressionThresholdError,
  deriveAgentsUnit,
  deriveWebAccessUnit
} from "./general-form";
import { readJson } from "./settings-api";
import { useSaveUnit } from "./settings-config";
import { SelectField, TextField } from "./settings-fields";
import { SettingRow } from "./SettingRow";
import { SettingsSection } from "./SettingsSection";
import { DEFAULT_COMPRESSION_THRESHOLD_TOKENS, LOG_REQUEST_OPTIONS } from "./types";

/** General settings pane: Appearance, Agents, Web Access (desktop), Storage. */
export function GeneralPane() {
  return (
    <div className="flex flex-col gap-4">
      <AppearanceBlock />
      <AgentsBlock />
      {isDesktopRuntime() && <WebAccessBlock />}
      <StorageBlock />
    </div>
  );
}

/** Theme lives in local UI state, not server config — no save unit, no footer. */
function AppearanceBlock() {
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  return (
    <SettingsSection title="Appearance" rows>
      <SettingRow
        anchor="theme"
        label="Theme"
        description="Applies to this browser only — it is not part of your saved configuration."
        fit="auto"
      >
        <ToggleGroup
          type="single"
          value={theme}
          onValueChange={(value) => value && setTheme(value as Theme)}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="dark" aria-label="Dark theme">
            <Moon className="h-4 w-4" />
            <span className="ml-1.5">Dark</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="light" aria-label="Light theme">
            <Sun className="h-4 w-4" />
            <span className="ml-1.5">Light</span>
          </ToggleGroupItem>
        </ToggleGroup>
      </SettingRow>
    </SettingsSection>
  );
}

function AgentsBlock() {
  const unit = useSaveUnit({ derive: deriveAgentsUnit, buildPatch: buildAgentsPatch });
  const form = unit.form;
  if (!form) return null;
  const thresholdError = compressionThresholdError(form.compressionThresholdTokens);
  const showThresholdError = unit.footer.dirty && Boolean(thresholdError);
  return (
    <SettingsSection
      title="Agents"
      rows
      footer={{ ...unit.footer, disabled: !unit.footer.dirty || Boolean(thresholdError) }}
    >
      <SettingRow
        anchor="agent-preferences"
        label="Delegation preferences"
        description="Who should handle planning, implementation, review, and other delegated work."
        hint="Preferences, not hard rules. Agents follow them when practical."
        stacked
      >
        <textarea
          className="min-h-24 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm leading-relaxed outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50"
          value={form.preferences}
          aria-label="Delegation preferences"
          placeholder="Prefer Claude for planning and Codex for implementation."
          autoCapitalize="sentences"
          autoCorrect="on"
          spellCheck
          onChange={(event) =>
            unit.setForm((prev) => ({ ...prev, preferences: event.target.value }))
          }
        />
      </SettingRow>
      <SettingRow
        anchor="context-compression"
        label={<label htmlFor="compression-threshold">Context compression threshold</label>}
        description="Summarize older conversation history when context reaches this size. Shared by Manager and Workers."
      >
        <div className="mt-2.5 sm:mt-0">
          <div
            className="flex h-9 items-center overflow-hidden rounded-md border border-border bg-background focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20 data-[invalid=true]:border-destructive"
            data-invalid={showThresholdError || undefined}
          >
            <input
              id="compression-threshold"
              className="h-full min-w-0 flex-1 bg-transparent px-3 font-mono text-[13px] tabular-nums outline-none disabled:cursor-not-allowed disabled:opacity-50"
              aria-describedby="threshold-hint threshold-error"
              aria-invalid={showThresholdError}
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              value={form.compressionThresholdTokens}
              disabled={unit.footer.saving}
              onChange={(event) =>
                unit.setForm((prev) => ({ ...prev, compressionThresholdTokens: event.target.value }))
              }
            />
            <span className="border-l border-border px-2.5 text-xs text-chrome">tokens</span>
          </div>
          <div id="threshold-hint" className="mt-1.5 flex items-center justify-between gap-3 text-xs text-chrome">
            <span>Default: {DEFAULT_COMPRESSION_THRESHOLD_TOKENS.toLocaleString("en-US")}</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Reset threshold to default"
              disabled={unit.footer.saving || form.compressionThresholdTokens.trim() === String(DEFAULT_COMPRESSION_THRESHOLD_TOKENS)}
              onClick={() => unit.setForm((prev) => ({
                ...prev,
                compressionThresholdTokens: String(DEFAULT_COMPRESSION_THRESHOLD_TOKENS)
              }))}
            >
              <RotateCcw className="h-3 w-3" />
              <span>Reset</span>
            </button>
          </div>
          <p id="threshold-error" className="mt-1.5 text-xs text-destructive empty:hidden" role="status">
            {showThresholdError ? thresholdError : ""}
          </p>
        </div>
      </SettingRow>
      <SettingRow
        anchor="agent-logging"
        label="Agent logging"
        description="Debugs agent wake and compression calls."
        hint={
          form.logRequests === "full" ? (
            <AmberNote>
              Full logging stores prompts, responses, parsed output, tool context, and repair text
              in the local database.
            </AmberNote>
          ) : undefined
        }
      >
        <SelectField
          ariaLabel="Agent logging"
          value={form.logRequests}
          options={LOG_REQUEST_OPTIONS}
          onChange={(logRequests) => unit.setForm((prev) => ({ ...prev, logRequests }))}
        />
      </SettingRow>
    </SettingsSection>
  );
}

function WebAccessBlock() {
  const unit = useSaveUnit({
    derive: deriveWebAccessUnit,
    buildPatch: buildWebAccessPatch,
    restartReason: "Server address"
  });
  const form = unit.form;
  if (!form) return null;
  return (
    <SettingsSection
      title="Web Access"
      description="The address the desktop backend listens on."
      restartPill
      rows
      footer={unit.footer}
    >
      <div className="px-4 py-3">
        <AmberNote>
          Keep <code className="font-mono">127.0.0.1</code> for local-only use. Use{" "}
          <code className="font-mono">0.0.0.0</code> or a LAN IP only behind a trusted network or
          authenticated proxy.
        </AmberNote>
      </div>
      <SettingRow
        anchor="web-host"
        label="Listen address"
        description="Local-only by default. Use 0.0.0.0 for all network interfaces."
      >
        <TextField
          ariaLabel="Listen address"
          value={form.host}
          mono
          onChange={(host) => unit.setForm((prev) => ({ ...prev, host }))}
        />
      </SettingRow>
      <SettingRow anchor="web-port" label="Port" description="Use 0 to pick one automatically.">
        <TextField
          ariaLabel="Port"
          value={form.port}
          mono
          onChange={(port) => unit.setForm((prev) => ({ ...prev, port }))}
        />
      </SettingRow>
    </SettingsSection>
  );
}

/**
 * The database's on-disk size and a manual cleanup trigger.
 *
 * `databaseBytes` / `bytesBefore` / `bytesAfter` are whole-file sizes
 * (page_count * page_size), not a sum over chat content — a VACUUM can move
 * the former but not the latter, so the row is labelled "Database" rather
 * than "Chat history" and the description explains what shrinks it.
 *
 * Cleanup holds bun:sqlite's synchronous lock for roughly 20 seconds, stalling
 * every agent on the server and not just this request — the description says so
 * up front, and the button shows a pending state instead of clicking silently.
 *
 * Both halves of that are foreground work, which is why the figure is not the
 * VACUUM's alone: measured on a copy of the 527.7 MB production database,
 * shortening the tool results took 10.1 s and the VACUUM behind it 9.0 s, 19.1 s
 * together. The truncation is the larger half.
 */
function StorageBlock() {
  const [bytes, setBytes] = useState<number | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(api.storageStatus);
        const payload = await readJson<StorageStatusResponse>(res);
        // readJson already throws on `{ ok: false }`, so this branch is
        // unreachable at runtime — it only narrows the union for the compiler.
        if ("error" in payload) throw new Error(payload.error);
        if (!cancelled) setBytes(payload.databaseBytes);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const cleanup = async () => {
    setCleaning(true);
    setError("");
    try {
      // No body to send; the header is what forces a CORS preflight, which is
      // what stops a page the user happens to be visiting from firing this.
      // The server rejects the request without it.
      const res = await fetch(api.storageCleanup, {
        method: "POST",
        headers: { "content-type": "application/json" }
      });
      const payload = await readJson<StorageCleanupResponse>(res);
      if ("error" in payload) throw new Error(payload.error);
      setBytes(payload.bytesAfter);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCleaning(false);
    }
  };

  // "Calculating size…" next to an error hint reads as still-loading, and the
  // GET is never retried, so it would say that forever.
  const sizeText = bytes !== null
    ? `${formatMegabytes(bytes)} stored.`
    : error ? "Size unavailable." : "Calculating size…";

  return (
    <SettingsSection title="Storage" rows>
      <SettingRow
        anchor="storage-cleanup"
        label="Database"
        description={`${sizeText} Cleaning up shortens long tool outputs in old conversations and pauses agents for about 20 seconds.`}
        hint={error ? <span className="text-destructive">{error}</span> : undefined}
        fit="auto"
      >
        <Button variant="outline" size="sm" disabled={cleaning} onClick={() => void cleanup()}>
          {cleaning ? "Cleaning up…" : "Clean up now"}
        </Button>
      </SettingRow>
    </SettingsSection>
  );
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function AmberNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-md border border-amber/30 bg-amber/10 px-3 py-2 text-xs leading-relaxed text-amber">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <p>{children}</p>
    </div>
  );
}
