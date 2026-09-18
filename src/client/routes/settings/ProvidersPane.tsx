import { useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { api } from "@/lib/api-paths";
import type { ProviderModelCatalogItem } from "@shared/api-contracts";
import {
  isValidProviderName,
  PROVIDER_SETUP_TEMPLATES,
  providerStatus,
  type ProviderCard,
  type ProviderForm,
  type ProviderSetupTemplateId
} from "./provider-form";
import { ProviderModelsEditor, type ProviderCatalog } from "./ProviderModelsEditor";
import { loginCodex, readJson } from "./settings-api";
import { CodexAuthBox, type CodexAuthStatus } from "./settings-codex-auth";
import { useSettingsConfig, type SectionFooterState } from "./settings-config";
import { SecretField, SelectField, TextField } from "./settings-fields";
import { SettingRow } from "./SettingRow";
import { SettingsSection } from "./SettingsSection";
import { StatusChip } from "./SettingsStatus";
import { CODEX_SERVICE_TIER_OPTIONS } from "./types";
import { useProviderCards } from "./useProviderCards";

type ProviderModelsPayload = { ok: true; models: ProviderModelCatalogItem[]; source?: string };
const EMPTY_CATALOG: ProviderCatalog = { models: [], source: "configured" };

export function ProvidersPane() {
  const { config, loadError, reload } = useSettingsConfig();
  const { cards, busy, updateForm, appendCard, deleteCard, setCardError, footerFor } =
    useProviderCards();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [catalogs, setCatalogs] = useState<Record<string, ProviderCatalog>>({});
  const catalogRequestedRef = useRef(new Set<string>());
  const [authBusyId, setAuthBusyId] = useState("");
  const [authNotices, setAuthNotices] = useState<Record<string, string>>({});
  const [setupOpen, setSetupOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const setAuthNotice = (cardId: string, notice: string) => {
    setAuthNotices((prev) => ({ ...prev, [cardId]: notice }));
  };

  const ensureCatalog = async (card: ProviderCard) => {
    const cardId = card.form.id;
    const providerName = card.form.originalName;
    if (!providerName || catalogRequestedRef.current.has(cardId)) return;
    catalogRequestedRef.current.add(cardId);
    try {
      const res = await fetch(api.settingsProviderModels(providerName));
      const payload = await readJson<ProviderModelsPayload>(res);
      setCatalogs((prev) => ({
        ...prev,
        [cardId]: { models: payload.models, source: payload.source ?? "configured" }
      }));
    } catch {
      // Show the degraded state, but let the next expand retry: a fetch that
      // raced a dev-server restart must not pin "unavailable" for the session.
      catalogRequestedRef.current.delete(cardId);
      setCatalogs((prev) => ({ ...prev, [cardId]: EMPTY_CATALOG }));
    }
  };

  /** Re-ask the provider (busts the server's hourly cache). */
  const refreshCatalog = async (card: ProviderCard) => {
    const providerName = card.form.originalName;
    if (!providerName) return;
    try {
      const res = await fetch(`${api.settingsProviderModels(providerName)}?refresh=1`);
      const payload = await readJson<ProviderModelsPayload>(res);
      setCatalogs((prev) => ({
        ...prev,
        [card.form.id]: { models: payload.models, source: payload.source ?? "configured" }
      }));
    } catch {
      /* keep the previous catalog */
    }
  };

  const toggleCard = (card: ProviderCard) => {
    const cardId = card.form.id;
    const open = !expanded[cardId];
    setExpanded((prev) => ({ ...prev, [cardId]: open }));
    if (open) void ensureCatalog(card);
  };

  const addProvider = (templateId: ProviderSetupTemplateId) => {
    const form = appendCard(templateId);
    setExpanded((prev) => ({ ...prev, [form.id]: true }));
    setSetupOpen(false);
  };

  // Sign-in guard messages surface in the card's footer error.
  const startCodexLogin = async (card: ProviderCard) => {
    const cardId = card.form.id;
    const providerName = card.form.name.trim();
    if (!isValidProviderName(providerName)) {
      setCardError(cardId, "Provider names may use letters, numbers, dot, underscore, and hyphen.");
      return;
    }
    if (config?.models.providers[providerName]?.type !== "codex") {
      setCardError(cardId, "Save this OpenAI Codex provider before signing in.");
      return;
    }

    setAuthBusyId(cardId);
    setCardError(cardId, "");
    setAuthNotice(cardId, "");
    try {
      await loginCodex(providerName, () => setAuthNotice(cardId, "Browser sign-in opened."));
      await reload();
      setAuthNotice(cardId, "Codex sign-in complete.");
    } catch (err) {
      setAuthNotice(cardId, "");
      setCardError(cardId, err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusyId("");
    }
  };

  const logoutCodex = async (card: ProviderCard) => {
    const cardId = card.form.id;
    const providerName = card.form.name.trim();
    if (!isValidProviderName(providerName)) {
      setCardError(cardId, "Provider names may use letters, numbers, dot, underscore, and hyphen.");
      return;
    }

    setAuthBusyId(cardId);
    setCardError(cardId, "");
    setAuthNotice(cardId, "");
    try {
      const res = await fetch(api.codexAuthLogout, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerName })
      });
      await readJson<{ ok: true; auth: CodexAuthStatus }>(res);
      await reload();
      setAuthNotice(cardId, "Codex sign-out complete.");
    } catch (err) {
      setCardError(cardId, err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusyId("");
    }
  };

  const handleDeleteConfirm = () => {
    // `busy` mirrors the pane-level write lock; deleteCard re-checks it
    // synchronously, so a click that races the re-render still can't POST.
    if (deleteTargetId === null || deleting || busy) return;
    const cardId = deleteTargetId;
    setDeleting(true);
    void (async () => {
      try {
        await deleteCard(cardId);
      } catch (err) {
        setCardError(cardId, err instanceof Error ? err.message : String(err));
      } finally {
        setDeleting(false);
        setDeleteTargetId(null);
      }
    })();
  };

  if (!config) {
    return loadError ? <div className="text-sm text-destructive">{loadError}</div> : null;
  }

  const deleteTarget = cards.find((card) => card.form.id === deleteTargetId);

  return (
    // gap-2, not gap-4: collapsed providers are a list, and the wider gap made
    // three 56px rows read as three unrelated cards. Each still keeps its own
    // border, because that border is what turns amber when the card is dirty.
    <div className="flex flex-col gap-1.5">
      {/* The pane's own header line, on the list language: title · meta ·
          a 28px control. Each provider below is a row that opens in place. */}
      <div data-slot="section-header" className="flex h-8 items-center gap-2">
        <span data-slot="section-title" className="text-xs font-semibold text-foreground">Providers</span>
        <span data-slot="section-meta" className="min-w-0 truncate text-2xs text-faint">each saves on its own</span>
        <span className="flex-1" />
        <Button variant="outline" size="xs" onClick={() => setSetupOpen(true)}>
          <Plus className="size-3.5" />
          <span>Add provider</span>
        </Button>
      </div>

      {cards.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border-soft px-4 py-10 text-center">
          <div>
            <p className="text-sm text-muted-foreground">No providers configured.</p>
            <p className="mt-1 text-xs text-chrome">
              Agents can&apos;t run until at least one model is reachable.
            </p>
          </div>
          <Button variant="outline" size="xs" onClick={() => setSetupOpen(true)}>
            <Plus className="size-3.5" />
            <span>Add provider</span>
          </Button>
        </div>
      ) : (
        cards.map((card) => (
          <ProviderCardSection
            key={card.form.id}
            card={card}
            open={Boolean(expanded[card.form.id])}
            footer={footerFor(card)}
            catalog={catalogs[card.form.id] ?? EMPTY_CATALOG}
            onRefreshCatalog={() => void refreshCatalog(card)}
            authBusy={authBusyId === card.form.id}
            authNotice={authNotices[card.form.id] ?? ""}
            canCodexAuth={config.models.providers[card.form.name.trim()]?.type === "codex"}
            deleteDisabled={busy}
            onToggle={() => toggleCard(card)}
            onFormChange={(next) => updateForm(card.form.id, next)}
            onCodexLogin={() => void startCodexLogin(card)}
            onCodexLogout={() => void logoutCodex(card)}
            onRequestDelete={() => setDeleteTargetId(card.form.id)}
          />
        ))
      )}

      <ProviderSetupDialog open={setupOpen} onOpenChange={setSetupOpen} onSelect={addProvider} />

      <Dialog
        open={deleteTargetId !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTargetId(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove provider</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Remove provider{" "}
            <span className="font-semibold text-foreground">
              {deleteTarget?.form.name.trim() || "this provider"}
            </span>
            ? Model routes pointing at it will stop resolving.
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={deleting}
              onClick={() => setDeleteTargetId(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleting || busy}
              onClick={handleDeleteConfirm}
            >
              {deleting ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProviderCardSection({
  card,
  open,
  footer,
  catalog,
  onRefreshCatalog,
  authBusy,
  authNotice,
  canCodexAuth,
  deleteDisabled,
  onToggle,
  onFormChange,
  onCodexLogin,
  onCodexLogout,
  onRequestDelete
}: {
  card: ProviderCard;
  open: boolean;
  footer: SectionFooterState;
  catalog: ProviderCatalog;
  onRefreshCatalog: () => void;
  authBusy: boolean;
  authNotice: string;
  canCodexAuth: boolean;
  deleteDisabled: boolean;
  onToggle: () => void;
  onFormChange: (form: ProviderForm) => void;
  onCodexLogin: () => void;
  onCodexLogout: () => void;
  onRequestDelete: () => void;
}) {
  const form = card.form;
  const isCodex = form.type === "codex";
  return (
    <SettingsSection
      title={form.name.trim() || "New provider"}
      titleMeta={
        <>
          <span className="rounded-xs border border-border-soft px-1.5 font-mono text-2xs text-chrome">
            {form.type}
          </span>
          {/* Collapsed, a provider row said only its name and status. The model
              count is the one thing you actually open a card to check. */}
          {!open && form.models.length > 0 ? (
            <span className="text-2xs text-chrome">
              {form.models.length} {form.models.length === 1 ? "model" : "models"}
            </span>
          ) : null}
        </>
      }
      headerSlot={<ProviderStatusChip form={form} />}
      collapse={{ open, onToggle }}
      rows
      footer={footer}
    >
      <SettingRow label="Name" description="Used as the prefix in every model reference.">
        <TextField
          ariaLabel="Provider name"
          value={form.name}
          mono
          onChange={(name) => onFormChange({ ...form, name })}
        />
      </SettingRow>
      {isCodex ? (
        <SettingRow label="Service tier">
          <SelectField
            ariaLabel="Service tier"
            value={form.serviceTier}
            options={CODEX_SERVICE_TIER_OPTIONS}
            onChange={(serviceTier) => onFormChange({ ...form, serviceTier })}
          />
        </SettingRow>
      ) : (
        <>
          <SettingRow label="API key">
            <SecretField
              configured={form.configured}
              value={form.apiKey}
              clear={form.clearApiKey}
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
          {form.type === "kilo" && (
            <SettingRow label="Organization ID">
              <TextField
                ariaLabel="Organization ID"
                value={form.organizationId}
                mono
                onChange={(organizationId) => onFormChange({ ...form, organizationId })}
              />
            </SettingRow>
          )}
        </>
      )}
      {isCodex && (
        <SettingRow label="Account" description={authNotice || undefined} stacked>
          <CodexAuthBox
            auth={form.auth}
            busy={authBusy}
            canAuth={canCodexAuth}
            onLogin={onCodexLogin}
            onLogout={onCodexLogout}
          />
        </SettingRow>
      )}
      <ProviderModelsEditor
        models={form.models}
        catalog={catalog}
        onRefresh={onRefreshCatalog}
        onChange={(models) => onFormChange({ ...form, models })}
      />
      <div className="px-4 py-2">
        <Button
          variant="ghost"
          size="xs"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={deleteDisabled}
          onClick={onRequestDelete}
        >
          <Trash2 className="h-3.5 w-3.5" />
          <span>Remove provider</span>
        </Button>
      </div>
    </SettingsSection>
  );
}

const PROVIDER_STATUS_CHIP = {
  connected: { tone: "ready", label: "Connected" },
  "signed-in": { tone: "ready", label: "Signed in" },
  expired: { tone: "attention", label: "Sign-in expired" },
  unconfigured: { tone: "idle", label: "Not configured" }
} as const;

function ProviderStatusChip({ form }: { form: ProviderForm }) {
  const chip = PROVIDER_STATUS_CHIP[providerStatus(form)];
  return <StatusChip tone={chip.tone} label={chip.label} />;
}

function ProviderSetupDialog({
  open,
  onOpenChange,
  onSelect
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (templateId: ProviderSetupTemplateId) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Template cards are self-describing; no separate description element. */}
      <DialogContent className="sm:max-w-[640px]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Add provider</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {PROVIDER_SETUP_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              // flex-col, not the default: a stretched button centres its
              // content vertically, so the cards with a one-line description
              // sat 11px lower than their neighbours and no row of titles
              // lined up.
              className="flex min-h-24 flex-col items-start rounded-md border border-border-soft bg-panel p-4 text-left transition hover:border-ring hover:bg-sel focus:outline-none focus:ring-[3px] focus:ring-ring/20"
              onClick={() => onSelect(template.id)}
            >
              <div className="text-sm font-semibold text-foreground">{template.title}</div>
              <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {template.detail}
              </div>
              {template.defaultModelIds[0] && (
                <div className="mt-3 font-mono text-xs text-muted-foreground">
                  {template.defaultName}/{template.defaultModelIds[0]}
                </div>
              )}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
