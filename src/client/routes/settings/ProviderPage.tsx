import type { ReactNode } from "react";
import { Check as CheckIcon, ChevronLeft, MoreHorizontal, Trash2, X } from "lucide-react";
import { RelativeTime } from "@/components/RelativeTime";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { API_KEY_PAGES, markLetter, providerTypeLabel } from "./provider-display";
import type { ProviderCard, ProviderForm } from "./provider-form";
import { ProviderMark } from "./ProviderMark";
import { BillingRow } from "./PriceField";
import { RemoveBlocked } from "./ProviderModels";
import { CodexAuthBox } from "./settings-codex-auth";
import { footerHasSomethingToSay, type SectionFooterState } from "./settings-config";
import { SecretField, SelectField, TextField } from "./settings-fields";
import { SettingRow } from "./SettingRow";
import { SectionFooterBar, SettingsSection } from "./SettingsSection";
import { CODEX_SERVICE_TIER_OPTIONS } from "./types";
import type { ProviderCheckState } from "./useProviderChecks";

/**
 * One provider's page: back to the list, its header (mark, name, type,
 * Check, the actions menu), the last check's answer, its connection, its
 * models (saved as they are changed), and the save bar while its connection,
 * or a provider not saved yet, has something to save.
 */
export function ProviderPage({
  card,
  footer,
  check,
  busy,
  authBusy,
  authNotice,
  canCodexAuth,
  models,
  onBack,
  onCheck,
  onFormChange,
  onCodexLogin,
  onCodexLogout,
  onRequestDelete,
  removeBlocked,
  planSuggested = false
}: {
  card: ProviderCard;
  footer: SectionFooterState;
  check: ProviderCheckState | undefined;
  busy: boolean;
  authBusy: boolean;
  authNotice: string;
  canCodexAuth: boolean;
  /** The Models section. */
  models: ReactNode;
  onBack: () => void;
  onCheck: () => void;
  onFormChange: (form: ProviderForm) => void;
  onCodexLogin: () => void;
  onCodexLogout: () => void;
  onRequestDelete: () => void;
  /** What uses its models, when something does: it cannot be removed then. */
  removeBlocked: string | null;
  /** Its saved address looks like a plan's: Billing suggests it. */
  planSuggested?: boolean;
}) {
  const form = card.form;
  const isCodex = form.type === "codex";
  const name = form.originalName || form.name.trim() || "New provider";
  const checking = check?.phase === "checking";
  // A check reads the saved settings: changed ones are checked once saved.
  const checkWaits = card.baseline === null || connectionEdited(card);

  return (
    <div data-slot="provider-page" className="flex min-w-0 flex-col gap-4">
      <button
        type="button"
        // A 44px line of its own on a touch screen: a touch area grown from
        // the text reached into the section tabs above.
        className="inline-flex items-center gap-1 self-start text-xs text-chrome transition-colors hover:text-foreground pointer-coarse:min-h-11"
        onClick={onBack}
      >
        <ChevronLeft className="size-3.5" aria-hidden />
        Providers
      </button>

      <div className="flex min-w-0 items-center gap-3">
        <ProviderMark letter={markLetter(name)} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 data-slot="provider-title" className="truncate text-base font-semibold leading-snug">{name}</h2>
          <p className="truncate text-2xs text-faint">{providerTypeLabel(form.type)}</p>
        </div>
        {isCodex ? null : (
          // Waiting for a save, the button says so itself: a title on a
          // disabled button shows to no pointer and no touch.
          <Button
            variant="outline"
            size="xs"
            disabled={checking || checkWaits}
            onClick={onCheck}
          >
            {checking ? "Checking…" : checkWaits ? "Save to check" : "Check"}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-chrome hover:text-foreground"
              aria-label="Provider actions"
              title="Provider actions"
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              variant="destructive"
              disabled={busy || removeBlocked !== null}
              onSelect={() => { if (!busy && removeBlocked === null) onRequestDelete(); }}
            >
              <Trash2 className="h-4 w-4" />
              Remove provider…
            </DropdownMenuItem>
            {removeBlocked ? <RemoveBlocked>{removeBlocked}</RemoveBlocked> : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {isCodex ? null : <CheckLine check={check} />}

      <SettingsSection title="Connection" rows>
        {form.originalName ? null : (
          <SettingRow label="Name" description="Used in model references. Fixed once saved.">
            <TextField
              ariaLabel="Provider name"
              value={form.name}
              mono
              onChange={(next) => onFormChange({ ...form, name: next })}
            />
          </SettingRow>
        )}
        {isCodex ? (
          <>
            <SettingRow label="Account" description={authNotice || undefined} fit="auto">
              <CodexAuthBox
                auth={form.auth}
                busy={authBusy}
                canAuth={canCodexAuth}
                onLogin={onCodexLogin}
                onLogout={onCodexLogout}
              />
            </SettingRow>
            <SettingRow label="Service tier">
              <SelectField
                ariaLabel="Service tier"
                value={form.serviceTier}
                options={CODEX_SERVICE_TIER_OPTIONS}
                onChange={(serviceTier) => onFormChange({ ...form, serviceTier })}
              />
            </SettingRow>
          </>
        ) : (
          <>
            <SettingRow label="API key">
              <SecretField
                configured={form.configured}
                value={form.apiKey}
                clear={form.clearApiKey}
                getKeyUrl={API_KEY_PAGES[form.type]}
                onValueChange={(apiKey) => onFormChange({ ...form, apiKey })}
                onClearChange={(clearApiKey) => onFormChange({ ...form, clearApiKey })}
              />
            </SettingRow>
            <SettingRow label="Base URL">
              <TextField
                ariaLabel="Base URL"
                value={form.baseURL}
                mono
                onChange={(baseURL) => onFormChange({ ...form, baseURL })}
              />
            </SettingRow>
            {form.type === "kilo" ? (
              <SettingRow label="Organization ID">
                <TextField
                  ariaLabel="Organization ID"
                  value={form.organizationId}
                  mono
                  onChange={(organizationId) => onFormChange({ ...form, organizationId })}
                />
              </SettingRow>
            ) : null}
          </>
        )}
        <BillingRow billing={form.billing} planSuggested={planSuggested} onChange={(billing) => onFormChange({ ...form, billing })} />
      </SettingsSection>

      {models}

      {footerHasSomethingToSay(footer) ? (
        // Sticks to the bottom of the settings scroller, so Save is in reach
        // wherever the edit was made.
        <div
          data-slot="provider-save-bar"
          className={cn(
            "sticky bottom-0 z-10 overflow-hidden rounded-lg border bg-panel",
            footer.dirty ? "border-status-review/45" : "border-border-soft"
          )}
        >
          <SectionFooterBar footer={footer} />
        </div>
      ) : null}
    </div>
  );
}

/** The last check's answer, under the header; nothing before one. A check
 *  with no key to use says so plainly, neither ready nor failed (Check
 *  otherwise looked like it did nothing). */
function CheckLine({ check }: { check: ProviderCheckState | undefined }) {
  if (check?.phase !== "done") return null;
  if (check.check.result === "unchecked") {
    if (check.check.reason !== "no-key") return null;
    return (
      <p data-slot="provider-check" className="rounded-md bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        Not checked — no API key is saved.
      </p>
    );
  }
  const result = check.check;
  const ready = result.result === "ready";
  return (
    <p
      data-slot="provider-check"
      className={cn(
        "flex items-start gap-2 rounded-md px-3 py-2 text-xs leading-relaxed",
        ready ? "bg-live/10 text-live" : "bg-destructive/10 text-destructive"
      )}
    >
      {ready ? <CheckIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <X className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
      <span className="min-w-0 break-words">
        {result.result === "ready" ? (
          <>
            Ready — the key works and {result.modelCount} {result.modelCount === 1 ? "model is" : "models are"} listed. Checked{" "}
            <RelativeTime value={result.checkedAt} />.
          </>
        ) : (
          <>
            Check failed — {/[.!?…]$/.test(result.message) ? result.message : `${result.message}.`} Checked{" "}
            <RelativeTime value={result.checkedAt} />.
          </>
        )}
      </span>
    </p>
  );
}

/** Whether the settings a check depends on differ from the saved ones. */
function connectionEdited(card: ProviderCard): boolean {
  const { form, baseline } = card;
  if (!baseline) return true;
  return (
    form.apiKey.trim() !== "" ||
    form.clearApiKey ||
    form.baseURL !== baseline.baseURL ||
    form.organizationId !== baseline.organizationId
  );
}
