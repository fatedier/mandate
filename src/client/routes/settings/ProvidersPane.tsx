import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { ChevronRight, Plus } from "lucide-react";
import { Section } from "@/components/Section";
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
import { withParam } from "@/lib/url-params";
import type { ProviderModelCatalogItem } from "@shared/api-contracts";
import { errorText } from "@shared/error-text";
import {
  inUseLine,
  markLetter,
  providerRoutingUses,
  providerTypeLabel,
  routingUseLabel
} from "./provider-display";
import {
  isValidProviderName,
  PROVIDER_SETUP_TEMPLATES,
  connectionOf,
  PROVIDER_STATUS_CHIP,
  providerKey,
  providerStatus,
  serializeProviderForm,
  type ProviderCard,
  type ProviderForm,
  type ProviderSetupTemplateId
} from "./provider-form";
import { ProviderMark } from "./ProviderMark";
import { ProviderModels, RemoveBlocked, type ProviderCatalog } from "./ProviderModels";
import { PricesSection } from "./PriceField";
import { ProviderPage } from "./ProviderPage";
import { loginCodex, logoutCodex as signOutCodex, readJson } from "./settings-api";
import { useSettingsConfig } from "./settings-config";
import { StatusChip } from "./SettingsStatus";
import type { SettingsConfigResponse } from "./types";
import { useProviderCards } from "./useProviderCards";
import { checkFor, useProviderChecks, type ProviderCheckState } from "./useProviderChecks";
import { useProviderPricing } from "./usePricing";

type ProviderModelsPayload = { ok: true; models: ProviderModelCatalogItem[]; source?: string };
const EMPTY_CATALOG: ProviderCatalog = { models: [], source: "configured" };
/** Before any list: a saved provider is being asked; a new one has nothing
 *  to ask with until it is saved. */
const LOADING_CATALOG: ProviderCatalog = { models: [], source: "loading" };
const UNSAVED_CATALOG: ProviderCatalog = { models: [], source: "unsaved" };
/** The list asks for checks no older than this; the server answers older
 *  ones by listing the provider's models again. */
const LIST_CHECK_MAX_AGE_MS = 60 * 60_000;

/** The `provider` search param of a card: a saved provider's name, or the
 *  client id of one not saved yet (a reload drops it, as it drops the card). */
function providerParam(card: ProviderCard): string {
  return card.baseline === null ? `~${card.form.id}` : providerKey(card.form);
}

/** The card a `provider` param names: a new card by its id even once saved,
 *  until the URL catches up with its name. */
function cardForParam(cards: ProviderCard[], param: string | null): ProviderCard | null {
  if (!param) return null;
  if (param.startsWith("~")) return cards.find((card) => card.form.id === param.slice(1)) ?? null;
  return cards.find((card) => card.baseline !== null && providerKey(card.form) === param) ?? null;
}

/**
 * Settings › Providers: the providers as a list, each opening a page of its
 * own (`?provider=`). Each provider saves on its own; a save sends the whole
 * providers record (useProviderCards). What is done to a saved provider's
 * models is saved at once; its connection waits for the page's Save.
 */
export function ProvidersPane() {
  const { config, reload } = useSettingsConfig();
  const { checks, runCheck } = useProviderChecks();
  const { cards, busy, updateForm, appendCard, saveModels, deleteCard, setCardError, footerFor } =
    useProviderCards({
      onSaved: (name, saved) => {
        runCheck(name, 0, connectionOf(saved));
        // A save can change what the provider lists (a key fixed): Add
        // models reads the list again.
        reloadCatalog(saved);
      }
    });
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [catalogs, setCatalogs] = useState<Record<string, ProviderCatalog>>({});
  const catalogRequestedRef = useRef(new Set<string>());
  const [authBusyId, setAuthBusyId] = useState("");
  const [authNotices, setAuthNotices] = useState<Record<string, string>>({});
  const [setupOpen, setSetupOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const param = searchParams.get("provider");
  const selected = cardForParam(cards, param);
  // A link from a call in Activity names its model too: its dialog opens,
  // and the link forgets it (Back or a reload does not open it again).
  const modelParam = searchParams.get("model");
  const dropModelParam = useCallback(() => {
    setSearchParams((prev) => withParam(prev, "model", null), { replace: true, state: location.state });
  }, [setSearchParams, location.state]);
  // What Automatic finds for the saved models, read again when what it
  // depends on is saved.
  const pricing = useProviderPricing(
    selected?.baseline ? providerKey(selected.form) : null,
    selected?.baseline ? pricingVersion(selected.baseline) : ""
  );
  const fromList = (location.state as { fromProviders?: boolean } | null)?.fromProviders === true;

  // Opening the list checks every saved provider with a key, from a result
  // up to an hour old: the list says which ones work without a fetch each visit.
  const listShown = selected === null;
  // Keyed by the saved connection too: settings changed elsewhere (another
  // tab, the config file) and read by Refresh are checked again.
  const keyedProviders = JSON.stringify(
    cards
      .filter((card) => card.baseline !== null && card.baseline.type !== "codex" && card.baseline.configured)
      .map((card) => [providerKey(card.form), connectionOf(card.baseline!)])
  );
  useEffect(() => {
    if (!listShown) return;
    for (const [name, connection] of JSON.parse(keyedProviders) as Array<[string, string]>) {
      runCheck(name, LIST_CHECK_MAX_AGE_MS, connection);
    }
  }, [listShown, keyedProviders, runCheck]);

  // A link naming no saved provider shows the list and goes: kept, it
  // would open a provider made later under that name by itself (another
  // tab, the config file, read by Refresh). Read from the config, not the
  // cards, which are empty on the first render.
  const providers = config?.models.providers;
  useEffect(() => {
    if (!providers || !param || param.startsWith("~") || Object.hasOwn(providers, param)) return;
    setSearchParams((prev) => withParam(withParam(prev, "provider", null), "model", null), { replace: true, state: location.state });
  }, [providers, param, setSearchParams, location.state]);
  // A model named with no provider has nothing to open.
  useEffect(() => {
    if (providers && !param && modelParam !== null) dropModelParam();
  }, [providers, param, modelParam, dropModelParam]);

  // A new provider's first save: the URL takes its saved name.
  useEffect(() => {
    if (!selected || !param?.startsWith("~") || selected.baseline === null) return;
    setSearchParams((prev) => withParam(prev, "provider", providerKey(selected.form)), { replace: true, state: location.state });
  }, [selected, param, setSearchParams, location.state]);

  const setAuthNotice = (cardId: string, notice: string) => {
    setAuthNotices((prev) => ({ ...prev, [cardId]: notice }));
  };

  /** A provider's newest catalog request: an answer to an older one (a
   *  save landed since, with another key or address) is dropped. */
  const catalogRequestRef = useRef(new Map<string, number>());
  const nextCatalogRequest = (cardId: string) => {
    const request = (catalogRequestRef.current.get(cardId) ?? 0) + 1;
    catalogRequestRef.current.set(cardId, request);
    return () => catalogRequestRef.current.get(cardId) === request;
  };

  const ensureCatalog = async (card: ProviderCard) => {
    const cardId = card.form.id;
    const providerName = card.form.originalName;
    if (!providerName || catalogRequestedRef.current.has(cardId)) return;
    catalogRequestedRef.current.add(cardId);
    const current = nextCatalogRequest(cardId);
    try {
      const res = await fetch(api.settingsProviderModels(providerName));
      const payload = await readJson<ProviderModelsPayload>(res);
      if (!current()) return;
      setCatalogs((prev) => ({
        ...prev,
        [cardId]: { models: payload.models, source: payload.source ?? "configured" }
      }));
    } catch {
      if (!current()) return;
      // Show the degraded state, but let the next open retry: a fetch that
      // raced a dev-server restart must not pin "unavailable" for the session.
      catalogRequestedRef.current.delete(cardId);
      setCatalogs((prev) => ({ ...prev, [cardId]: EMPTY_CATALOG }));
    }
  };

  /** The list once more, after a save (the server dropped its cache). */
  const reloadCatalog = (form: ProviderForm) => {
    catalogRequestedRef.current.delete(form.id);
    void ensureCatalog({ form, baseline: form });
  };

  /** Re-ask the provider (busts the server's hourly cache). */
  const refreshCatalog = async (card: ProviderCard) => {
    const providerName = card.form.originalName;
    if (!providerName) return;
    const current = nextCatalogRequest(card.form.id);
    try {
      const res = await fetch(api.settingsProviderModels(providerName, { refresh: true }));
      const payload = await readJson<ProviderModelsPayload>(res);
      if (!current()) return;
      setCatalogs((prev) => ({
        ...prev,
        [card.form.id]: { models: payload.models, source: payload.source ?? "configured" }
      }));
    } catch {
      if (!current()) return;
      // Keep the previous catalog. With none yet, this was the newest
      // request and the first one's answer is dropped: show the degraded
      // state, and let the next open ask again (as ensureCatalog's failure).
      catalogRequestedRef.current.delete(card.form.id);
      setCatalogs((prev) => (prev[card.form.id] ? prev : { ...prev, [card.form.id]: EMPTY_CATALOG }));
    }
  };

  const selectedId = selected?.form.id;
  const selectedName = selected?.form.originalName;
  const loadSelectedCatalog = useEffectEvent(() => {
    if (selected) void ensureCatalog(selected);
  });
  // The catalog follows the provider shown, by its card and its saved name;
  // the request starts after the effect, as every fetch from an effect here.
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) loadSelectedCatalog();
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, selectedName]);

  /** Opens a provider's page as a new history entry. The list never keeps
   *  a param of its own: one that named nothing (a stale link) could name a
   *  provider made later, and Back would open it. */
  const pushProvider = (key: string) => {
    if (param !== null) setSearchParams((prev) => withParam(prev, "provider", null), { replace: true });
    setSearchParams((prev) => withParam(prev, "provider", key), { state: { fromProviders: true } });
  };

  const openProvider = (card: ProviderCard) => pushProvider(providerParam(card));

  const backToList = () => {
    if (fromList) navigate(-1);
    else setSearchParams((prev) => withParam(prev, "provider", null), { replace: true });
  };

  const addProvider = (templateId: ProviderSetupTemplateId) => {
    const form = appendCard(templateId);
    setSetupOpen(false);
    pushProvider(`~${form.id}`);
  };

  // Sign-in guard messages surface in the page's save bar.
  const startCodexLogin = async (card: ProviderCard) => {
    const cardId = card.form.id;
    const providerName = card.form.name.trim();
    if (!isValidProviderName(providerName)) {
      setCardError(cardId, { message: "Provider names may use letters, numbers, dot, underscore, and hyphen." });
      return;
    }
    if (config?.models.providers[providerName]?.type !== "codex") {
      setCardError(cardId, { message: "Save this OpenAI Codex provider before signing in." });
      return;
    }

    setAuthBusyId(cardId);
    setCardError(cardId, null);
    setAuthNotice(cardId, "");
    try {
      await loginCodex(providerName, () => setAuthNotice(cardId, "Browser sign-in opened."));
      await reload();
      setAuthNotice(cardId, "Codex sign-in complete.");
    } catch (err) {
      setAuthNotice(cardId, "");
      setCardError(cardId, { message: "Couldn't sign in.", detail: errorText(err) });
    } finally {
      setAuthBusyId("");
    }
  };

  const logoutCodex = async (card: ProviderCard) => {
    const cardId = card.form.id;
    const providerName = card.form.name.trim();
    if (!isValidProviderName(providerName)) {
      setCardError(cardId, { message: "Provider names may use letters, numbers, dot, underscore, and hyphen." });
      return;
    }

    setAuthBusyId(cardId);
    setCardError(cardId, null);
    setAuthNotice(cardId, "");
    try {
      await signOutCodex(providerName);
      await reload();
      setAuthNotice(cardId, "Codex sign-out complete.");
    } catch (err) {
      setCardError(cardId, { message: "Couldn't sign out.", detail: errorText(err) });
    } finally {
      setAuthBusyId("");
    }
  };

  const deleteTarget = cards.find((card) => card.form.id === deleteTargetId);
  // Settings read again while its removal is asked may find it in use.
  const deleteBlocked = deleteTarget && config ? removeBlockedOf(config, deleteTarget) : null;

  const handleDeleteConfirm = () => {
    // `busy` mirrors the pane-level write lock; deleteCard re-checks it
    // synchronously, so a click that races the re-render still can't POST.
    if (deleteTargetId === null || deleting || busy || deleteBlocked !== null) return;
    const cardId = deleteTargetId;
    setDeleting(true);
    void (async () => {
      try {
        await deleteCard(cardId);
        // Gone: back to the list, never a page for nothing.
        if (selectedId === cardId) backToList();
      } catch (err) {
        setCardError(cardId, { message: "Couldn't remove this provider.", detail: errorText(err) });
      } finally {
        setDeleting(false);
        setDeleteTargetId(null);
      }
    })();
  };

  // The page says loading and failed, once, for every pane.
  if (!config) return null;


  return (
    <>
      {selected ? (
        <ProviderPage
          card={selected}
          footer={footerFor(selected)}
          check={checkOf(checks, selected)}
          busy={busy}
          authBusy={authBusyId === selected.form.id}
          authNotice={authNotices[selected.form.id] ?? ""}
          canCodexAuth={config.models.providers[selected.form.name.trim()]?.type === "codex"}
          models={
            <ProviderModels
              // Its dialogs belong to one provider: another starts with none open.
              key={selected.form.id}
              providerKey={providerKey(selected.form)}
              providerType={selected.form.type}
              models={selected.form.models}
              config={config}
              catalog={catalogs[selected.form.id] ?? (selected.baseline ? LOADING_CATALOG : UNSAVED_CATALOG)}
              locked={busy}
              pricing={pricing}
              openModel={selected.baseline ? modelParam : null}
              onOpenModelDone={dropModelParam}
              onRefreshCatalog={() => void refreshCatalog(selected)}
              onSaveModels={(models) => saveModels(selected.form.id, models)}
            />
          }
          onBack={backToList}
          onCheck={() => { if (selected.baseline) runCheck(providerKey(selected.form), 0, connectionOf(selected.baseline)); }}
          onFormChange={(next) => updateForm(selected.form.id, next)}
          onCodexLogin={() => void startCodexLogin(selected)}
          onCodexLogout={() => void logoutCodex(selected)}
          onRequestDelete={() => setDeleteTargetId(selected.form.id)}
          removeBlocked={removeBlockedOf(config, selected)}
          planSuggested={pricing?.planSuggested === true}
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-5">
          <ProviderList
            cards={cards}
            config={config}
            checks={checks}
            onOpen={openProvider}
            onAdd={() => setSetupOpen(true)}
          />
          <PricesSection />
        </div>
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
          {/* Found in use since the menu was opened (settings read again). */}
          {deleteBlocked ? <RemoveBlocked>{deleteBlocked}</RemoveBlocked> : null}
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
              disabled={deleting || busy || deleteBlocked !== null}
              onClick={handleDeleteConfirm}
            >
              {deleting ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** What uses a saved provider's models, when something does: it cannot be
 *  removed then. One not saved yet is used by nothing. */
function removeBlockedOf(config: SettingsConfigResponse, card: ProviderCard): string | null {
  if (!card.baseline) return null;
  const name = providerKey(card.form);
  const ids = card.baseline.models.map((model) => model.modelId.trim());
  return inUseLine(
    providerRoutingUses(config, name, ids),
    ids.some((id) => config.memory.embedding.model === `${name}/${id}`)
  );
}

/** What a saved provider's prices depend on, as one string. */
function pricingVersion(saved: ProviderCard["form"]): string {
  return JSON.stringify([connectionOf(saved), saved.billing, saved.models.map((model) => [model.modelId.trim(), model.price ?? null])]);
}

/** A card's check, when it is for the connection it has saved. */
function checkOf(checks: Record<string, ProviderCheckState>, card: ProviderCard): ProviderCheckState | undefined {
  return card.baseline ? checkFor(checks, providerKey(card.form), connectionOf(card.baseline)) : undefined;
}

/** The list: one row per provider, opening its page. */
function ProviderList({
  cards,
  config,
  checks,
  onOpen,
  onAdd
}: {
  cards: ProviderCard[];
  config: SettingsConfigResponse;
  checks: Record<string, ProviderCheckState>;
  onOpen: (card: ProviderCard) => void;
  onAdd: () => void;
}) {
  const addButton = (
    <Button variant="outline" size="xs" onClick={onAdd}>
      <Plus className="size-3.5" />
      <span>Add provider</span>
    </Button>
  );
  return (
    // The jump target for a provider setting's search hit (each exists once
    // per provider): the list's header line flashes.
    <div id="setting-providers" className="scroll-mt-4">
      {cards.length === 0 ? (
        <Section title="Providers" trailing={addButton} panel={false}>
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border-soft px-4 py-10 text-center">
            <div>
              <p className="text-sm text-muted-foreground">No providers configured.</p>
              <p className="mt-1 text-xs text-chrome">
                Agents can&apos;t run until at least one model is reachable.
              </p>
            </div>
            {addButton}
          </div>
        </Section>
      ) : (
        <Section title="Providers" meta="each saves on its own" trailing={addButton}>
          {cards.map((card) => (
            <ProviderRow
              key={card.form.id}
              card={card}
              config={config}
              check={checkOf(checks, card)}
              onOpen={() => onOpen(card)}
            />
          ))}
        </Section>
      )}
    </div>
  );
}

function ProviderRow({
  card,
  config,
  check,
  onOpen
}: {
  card: ProviderCard;
  config: SettingsConfigResponse;
  check: ProviderCheckState | undefined;
  onOpen: () => void;
}) {
  const form = card.form;
  const name = providerKey(form) || "New provider";
  const count = form.models.length;
  const uses = providerRoutingUses(config, providerKey(form), form.models.map((model) => model.modelId.trim()));
  const subline = [
    providerTypeLabel(form.type),
    `${count} ${count === 1 ? "model" : "models"}`,
    ...(uses.length > 0 ? [uses.map((use) => routingUseLabel(use, "subline")).join(", ")] : [])
  ].join(" · ");
  const chip = PROVIDER_STATUS_CHIP[providerStatus(card, check)];
  const unsaved = card.baseline !== null && serializeProviderForm(card.form) !== serializeProviderForm(card.baseline);
  return (
    <button
      type="button"
      data-provider-row={name}
      className="flex min-h-13 w-full items-center gap-3 border-t border-border-soft px-3.5 py-2 text-left transition-colors first:border-t-0 hover:bg-sel"
      onClick={onOpen}
    >
      <ProviderMark letter={markLetter(name)} size="md" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{name}</span>
          {unsaved ? (
            <span data-unsaved aria-label="Unsaved changes" className="block h-1.5 w-1.5 shrink-0 rounded-full bg-status-review" />
          ) : null}
        </span>
        <span className="block truncate text-2xs text-faint">{subline}</span>
      </span>
      <StatusChip tone={chip.tone} label={chip.label} className="shrink-0" />
      <ChevronRight className="size-3.5 shrink-0 text-chrome" aria-hidden />
    </button>
  );
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
      {/* Template cards are self-describing; no separate description element.
          Taller than a short phone: the title and × stay, the list scrolls
          (pt-1 and scroll-py-1 keep a card's focus ring inside the scroller). */}
      <DialogContent className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px]" aria-describedby={undefined}>
        <DialogHeader className="shrink-0 px-6 pt-6 pb-3">
          <DialogTitle>Add provider</DialogTitle>
        </DialogHeader>
        {/* The scroller and the grid are two boxes: a grid held to the
            scroller's height squeezes its rows to the cards' min height,
            and a wrapped description spills out of its card. */}
        <div data-slot="provider-templates" className="min-h-0 scroll-py-1 overflow-y-auto overscroll-contain px-6 pt-1 pb-6">
          <div className="grid gap-3 sm:grid-cols-2">
            {PROVIDER_SETUP_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                // flex-col, not the default: a stretched button centres its
                // content vertically, so the cards with a one-line description
                // sat 11px lower than their neighbours and no row of titles
                // lined up.
                // focus-visible: the dialog focuses the first card on open,
                // and with a plain `focus` ring a pointer or a tap opened it
                // looking already chosen.
                className="flex min-h-24 flex-col items-start rounded-md border border-border-soft bg-panel p-4 text-left transition hover:border-ring hover:bg-sel focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20"
                onClick={() => onSelect(template.id)}
              >
                <div className="text-sm font-semibold text-foreground">{template.title}</div>
                <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {template.detail}
                </div>
                {/* What it starts with, in words: the raw "codex/gpt-5.6-sol"
                    named one of Codex's four, under a provider name the new
                    card may not even get ("openai-2" beside an existing one). */}
                {template.defaultModelIds[0] && (
                  <div data-slot="template-models" className="mt-3 text-xs text-muted-foreground">
                    Starts with <span className="font-mono">{template.defaultModelIds[0]}</span>
                    {template.defaultModelIds.length > 1 && ` and ${template.defaultModelIds.length - 1} more`}
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
