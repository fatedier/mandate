import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Info, Monitor, Moon, RotateCcw, Sun } from "lucide-react";
import type { StorageCleanupResponse, StorageStatusResponse } from "@shared/api-contracts";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { InlineError } from "@/components/ViewState";
import { api } from "@/lib/api-paths";
import { isDesktopRuntime, isTauriRuntime } from "@/lib/runtime";
import { ZOOM_STEPS, formatZoom } from "@/lib/desktop-zoom";
import { SimpleSelect } from "@/components/ui/select";
import { useUIStore, type Theme } from "@/store/ui";
import {
  buildAgentsPatch,
  buildStoragePatch,
  buildWebAccessPatch,
  chatLimitError,
  compressionThresholdError,
  DEFAULT_CHAT_LIMIT_GB,
  deriveAgentsUnit,
  deriveStorageUnit,
  deriveWebAccessUnit,
  idleFieldErrors,
  tokenDigits
} from "./general-form";
import { readJson } from "./settings-api";
import { useSaveUnit, useSettingsConfig } from "./settings-config";
import { SelectField, TextField } from "./settings-fields";
import { SettingRow, SettingSubGroup } from "./SettingRow";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "./SettingsSection";
import { DEFAULT_COMPRESSION_THRESHOLD_TOKENS, LOG_REQUEST_OPTIONS } from "@shared/settings";
import { toolReviewAvailable } from "./routing-form";
import { TOOL_REVIEW_UNAVAILABLE } from "@shared/settings";
import { errorText } from "@shared/error-text";
import { DEFAULT_PERSONAL_AGENT_NAME, displayPersonalAgentName } from "@shared/personal-agent-name";

/** General settings pane: Appearance, Agents, Web Access (desktop), Storage. */
export function GeneralPane() {
  return (
    <div className="flex flex-col gap-4">
      <PersonalAgentBlock />
      <AppearanceBlock />
      <AgentsBlock />
      {isDesktopRuntime() && <WebAccessBlock />}
      <StorageBlock />
    </div>
  );
}

/** The personal agent's name. A name cleared here
 *  saves "Mandate", as a blank Start does: after Start the guide never
 *  returns. */
function PersonalAgentBlock() {
  const unit = useSaveUnit({
    derive: (config) => ({ name: config.agent.personalAgentName }),
    buildPatch: (form) => ({ agent: { personalAgentName: form.name.trim() || DEFAULT_PERSONAL_AGENT_NAME } })
  });
  const form = unit.form;
  if (!form) return null;
  const shown = displayPersonalAgentName(form.name.trim());
  return (
    <SettingsSection title="Personal agent" description="The agent above your threads." rows footer={unit.footer}>
      <SettingRow
        anchor="personal-agent-name"
        label="Name"
        description={`Shown in the sidebar, on its page, and on messages it sends for you ("via ${shown}").`}
      >
        <TextField
          ariaLabel="Personal agent's name"
          value={form.name}
          placeholder="Mandate"
          onChange={(name) => unit.setForm((prev) => ({ ...prev, name }))}
        />
      </SettingRow>
    </SettingsSection>
  );
}

const ZOOM_OPTIONS = ZOOM_STEPS.map((step) => ({ value: String(step), label: formatZoom(step) }));

/** Theme (and, in the desktop shell, zoom) live in local UI state, not server
 *  config — no save unit, no footer. */
function AppearanceBlock() {
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const zoom = useUIStore((s) => s.interfaceZoom);
  const setZoom = useUIStore((s) => s.setInterfaceZoom);
  return (
    <SettingsSection title="Appearance" rows>
      <SettingRow
        anchor="theme"
        label="Theme"
        description="System follows the OS appearance. Applies to this app only — it is not part of your saved configuration."
        fit="auto"
      >
        <ToggleGroup
          type="single"
          value={theme}
          onValueChange={(value) => value && setTheme(value as Theme)}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="system" aria-label="System theme">
            <Monitor className="h-4 w-4" />
            <span className="ml-1.5">System</span>
          </ToggleGroupItem>
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
      {isTauriRuntime() && (
        <SettingRow
          anchor="interface-zoom"
          label="Interface zoom"
          description="⌘+ and ⌘− step it, ⌘0 resets. Remembered on this Mac."
        >
          <SimpleSelect
            aria-label="Interface zoom"
            value={String(zoom)}
            options={ZOOM_OPTIONS}
            onValueChange={(next) => setZoom(Number(next))}
          />
        </SettingRow>
      )}
    </SettingsSection>
  );
}

function AgentsBlock() {
  const { config } = useSettingsConfig();
  const unit = useSaveUnit({ derive: deriveAgentsUnit, buildPatch: buildAgentsPatch });
  const form = unit.form;
  if (!form) return null;
  const thresholdError = compressionThresholdError(form.compressionThresholdTokens);
  const { lead: leadError, minTokens: minTokensError } = idleFieldErrors(form);
  // It holds calls back only on a second look: with no model for one it
  // cannot be on, and says where to set one.
  const reviewAvailable = config ? toolReviewAvailable(config) : false;
  const reviewOn = form.toolReviewEnabled && reviewAvailable;
  return (
    <SettingsSection
      title="Agents"
      rows
      footer={{ ...unit.footer, disabled: !unit.footer.dirty || Boolean(thresholdError || leadError || minTokensError) }}
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
        <TokenCountField
          id="compression-threshold"
          name="threshold"
          value={form.compressionThresholdTokens}
          defaultValue={DEFAULT_COMPRESSION_THRESHOLD_TOKENS}
          check={compressionThresholdError}
          showError={unit.footer.dirty}
          disabled={unit.footer.saving}
          onChange={(compressionThresholdTokens) => unit.setForm((prev) => ({ ...prev, compressionThresholdTokens }))}
        />
      </SettingRow>
      <SettingRow
        anchor="idle-compaction"
        label={<label htmlFor="idle-compaction-switch">Compact idle threads</label>}
        description="Before a long conversation's prompt cache expires, summarize it, so the next message doesn't pay to write the whole history again."
        fit="auto"
      >
        <Switch
          id="idle-compaction-switch"
          checked={form.idleCompactionEnabled}
          aria-label="Compact idle threads"
          disabled={unit.footer.saving}
          onCheckedChange={(idleCompactionEnabled) => unit.setForm((prev) => ({ ...prev, idleCompactionEnabled }))}
        />
      </SettingRow>
      {form.idleCompactionEnabled ? (
        <SettingSubGroup label="Idle compaction">
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Minutes before the cache expires"
              ariaLabel="Minutes before the cache expires"
              value={form.idleCompactionLeadMinutes}
              suffix="min"
              disabled={unit.footer.saving}
              hint={<FieldHint error={leadError}>Each model's cache lifetime is set in Providers: Claude an hour, GPT 30 minutes by default.</FieldHint>}
              onChange={(idleCompactionLeadMinutes) => unit.setForm((prev) => ({ ...prev, idleCompactionLeadMinutes }))}
            />
            <TextField
              label="Smallest context to compact"
              ariaLabel="Smallest context to compact"
              value={form.idleCompactionMinTokens}
              suffix="tokens"
              disabled={unit.footer.saving}
              hint={<FieldHint error={minTokensError}>Shorter threads are left as they are.</FieldHint>}
              onChange={(idleCompactionMinTokens) => unit.setForm((prev) => ({ ...prev, idleCompactionMinTokens }))}
            />
          </div>
        </SettingSubGroup>
      ) : null}
      <SettingRow
        anchor="tool-call-review"
        label={<label htmlFor="tool-call-review-switch">Review tool calls</label>}
        description="Before an agent runs a command, types into a terminal or writes outside its work, another model checks it and holds back what needs your word. Off unless you turn it on."
        hint={reviewAvailable ? undefined : TOOL_REVIEW_UNAVAILABLE}
        fit="auto"
      >
        <Switch
          id="tool-call-review-switch"
          checked={reviewOn}
          aria-label="Review tool calls"
          disabled={unit.footer.saving || !reviewAvailable}
          onCheckedChange={(toolReviewEnabled) => unit.setForm((prev) => ({ ...prev, toolReviewEnabled }))}
        />
      </SettingRow>
      {reviewOn ? (
        <SettingSubGroup label="Tool-call review">
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="label-micro text-chrome">Your rules</span>
            <textarea
              className="min-h-24 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm leading-relaxed outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50"
              value={form.toolReviewRules}
              aria-label="Your rules"
              placeholder="Agents may push their own feature branches. Always ask me before anything touches production."
              autoCapitalize="sentences"
              autoCorrect="on"
              spellCheck
              disabled={unit.footer.saving}
              onChange={(event) => unit.setForm((prev) => ({ ...prev, toolReviewRules: event.target.value }))}
            />
            <span className="text-xs leading-relaxed text-chrome">In your own words: what agents may do without asking, and what always needs your word. Agents read this too, and the review counts it as yours.</span>
          </label>
        </SettingSubGroup>
      ) : null}
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
 * Cleanup holds bun:sqlite's synchronous lock while it runs, seconds on a
 * large database, stalling every agent on the server and not just this request — the description says so
 * up front, and the button shows a pending state instead of clicking silently.
 *
 * Both halves of that are foreground work, which is why the wait is not the
 * VACUUM's alone: shortening the tool results takes as long as the VACUUM
 * behind it.
 */
function StorageBlock() {
  const unit = useSaveUnit({ derive: deriveStorageUnit, buildPatch: buildStoragePatch });
  const { config } = useSettingsConfig();
  const [bytes, setBytes] = useState<number | null>(null);
  const [cleaning, setCleaning] = useState(false);
  // What failed (the size read or a cleanup), and the server's text.
  const [error, setError] = useState<{ message: string; detail: string } | null>(null);

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
        if (!cancelled) setError({ message: "Couldn't read the database size.", detail: errorText(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const cleanup = async () => {
    setCleaning(true);
    setError(null);
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
      setError({ message: "Couldn't clean up the database.", detail: errorText(err) });
    } finally {
      setCleaning(false);
    }
  };

  // "Calculating size…" next to an error hint reads as still-loading, and the
  // GET is never retried, so it would say that forever.
  const sizeText = bytes !== null
    ? `${formatMegabytes(bytes)} stored.`
    : error ? "Size unavailable." : "Calculating size…";

  const limitError = unit.form ? chatLimitError(unit.form.chatLimitGb) : "";
  const headChars = config?.retention.chatToolResultHeadChars ?? 2000;
  return (
    <SettingsSection
      title="Storage"
      rows
      footer={unit.form ? { ...unit.footer, disabled: !unit.footer.dirty || Boolean(limitError) } : undefined}
    >
      <SettingRow
        anchor="storage-cleanup"
        label="Database"
        description={`${sizeText} Cleaning up shortens long tool outputs in old conversations and pauses agents for about 20 seconds.`}
        hint={error ? <InlineError detail={error.detail}>{error.message}</InlineError> : undefined}
        fit="auto"
      >
        <Button variant="outline" size="sm" disabled={cleaning} onClick={() => void cleanup()}>
          {cleaning ? "Cleaning up…" : "Clean up now"}
        </Button>
      </SettingRow>
      {unit.form ? (
        <SettingRow
          anchor="chat-history-limit"
          label={<label htmlFor="chat-history-limit">Chat history limit</label>}
          description={`Past this size, long tool outputs in the oldest conversations are shortened first; their first ${headChars.toLocaleString("en-US")} characters stay. Default ${DEFAULT_CHAT_LIMIT_GB} GB.`}
        >
          <SizeField
            id="chat-history-limit"
            value={unit.form.chatLimitGb}
            defaultValue={DEFAULT_CHAT_LIMIT_GB}
            error={unit.footer.dirty ? limitError : ""}
            disabled={unit.footer.saving}
            onChange={(chatLimitGb) => unit.setForm((prev) => ({ ...prev, chatLimitGb }))}
          />
        </SettingRow>
      ) : null}
    </SettingsSection>
  );
}

/** A size in GB, with Reset to the default below it and why it is refused. */
function SizeField({ id, value, defaultValue, error, disabled, onChange }: {
  id: string;
  value: string;
  defaultValue: string;
  error: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <div
        className="flex h-9 items-center overflow-hidden rounded-md border border-border bg-background focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20 data-[invalid=true]:border-destructive"
        data-invalid={Boolean(error) || undefined}
      >
        <input
          id={id}
          className="h-full min-w-0 flex-1 bg-transparent px-3 text-[13px] tabular-nums outline-none disabled:cursor-not-allowed disabled:opacity-50"
          aria-describedby={`${id}-error`}
          aria-invalid={Boolean(error)}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <span className="border-l border-border px-2.5 text-xs text-chrome">GB</span>
      </div>
      <div className="mt-1.5 flex items-center justify-end text-xs">
        <button
          type="button"
          className="hit relative inline-flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Reset chat history limit to default"
          disabled={disabled || Number(value) === Number(defaultValue)}
          onClick={() => onChange(defaultValue)}
        >
          <RotateCcw className="h-3 w-3" />
          <span>Reset</span>
        </button>
      </div>
      <p id={`${id}-error`} className="mt-1.5 text-xs text-destructive empty:hidden" role="status">
        {error}
      </p>
    </div>
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

/** A token count: "170,000" in the body font, like the default beside it, and
 *  plain digits while it is edited. Leaving the field writes what was typed
 *  back as plain digits, so "250,000" and "250000" are the same edit. A count
 *  the field refuses stays exactly as typed. */
/** A field's hint, or in its place why the value is refused. */
function FieldHint({ error, children }: { error: string; children: ReactNode }) {
  return error ? <span className="text-destructive" role="status">{error}</span> : <>{children}</>;
}

function TokenCountField({ id, name, value, defaultValue, check, showError, disabled, onChange }: {
  id: string;
  /** Names the hint and error ids and the Reset button. */
  name: "threshold";
  value: string;
  defaultValue: number;
  /** The field's rule: why `raw` is refused, or "" — the same one Save uses. */
  check: (raw: string) => string;
  showError: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Where the selection stood in the grouped value when focus arrived. The
  // swap to plain digits resets it (a value set on a focused input puts the
  // caret at the end), so Tab's select-all was lost and typing appended:
  // 170000250000, which no rule refuses. Put back after the swap.
  const selectionAtFocus = useRef<{ all: boolean; digitsBefore: number } | null>(null);
  useLayoutEffect(() => {
    const at = selectionAtFocus.current;
    const el = input.current;
    selectionAtFocus.current = null;
    if (!editing || !at || !el || document.activeElement !== el) return;
    if (at.all) {
      el.select();
      return;
    }
    let caret = 0;
    for (let digits = 0; caret < el.value.length && digits < at.digitsBefore; caret++) {
      if (/\d/.test(el.value[caret]!)) digits++;
    }
    el.setSelectionRange(caret, caret);
  }, [editing]);
  const refusal = check(value);
  const error = showError ? refusal : "";
  const count = refusal ? null : Number(tokenDigits(value));
  return (
    <div>
      <div
        className="flex h-9 items-center overflow-hidden rounded-md border border-border bg-background focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20 data-[invalid=true]:border-destructive"
        data-invalid={Boolean(error) || undefined}
      >
        <input
          ref={input}
          id={id}
          className="h-full min-w-0 flex-1 bg-transparent px-3 text-[13px] tabular-nums outline-none disabled:cursor-not-allowed disabled:opacity-50"
          aria-describedby={`${name}-hint ${name}-error`}
          aria-invalid={Boolean(error)}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          value={editing || count === null ? value : count.toLocaleString("en-US")}
          disabled={disabled}
          onFocus={(event) => {
            const el = event.currentTarget;
            const start = el.selectionStart ?? el.value.length;
            const end = el.selectionEnd ?? start;
            selectionAtFocus.current = {
              all: el.value.length > 0 && start === 0 && end === el.value.length,
              digitsBefore: el.value.slice(0, start).replace(/\D/g, "").length
            };
            setEditing(true);
          }}
          onBlur={() => {
            setEditing(false);
            if (count !== null && String(count) !== value) onChange(String(count));
          }}
          onChange={(event) => onChange(event.target.value)}
        />
        <span className="border-l border-border px-2.5 text-xs text-chrome">tokens</span>
      </div>
      <div id={`${name}-hint`} className="mt-1.5 flex items-center justify-between gap-3 text-xs text-chrome">
        <span>Default: {defaultValue.toLocaleString("en-US")}</span>
        <button
          type="button"
          className="hit relative inline-flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={`Reset ${name} to default`}
          disabled={disabled || count === defaultValue}
          onClick={() => onChange(String(defaultValue))}
        >
          <RotateCcw className="h-3 w-3" />
          <span>Reset</span>
        </button>
      </div>
      <p id={`${name}-error`} className="mt-1.5 text-xs text-destructive empty:hidden" role="status">
        {error}
      </p>
    </div>
  );
}
