import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildProvidersPatch,
  makeNewProvider,
  providerFormsFromConfig,
  providerKey,
  serializeProviderForm,
  type ModelForm,
  type ProviderCard,
  type ProviderForm,
  type ProviderSetupTemplateId
} from "./provider-form";
import { JUST_SAVED_MS, saveError, useSettingsConfig, type FooterError, type SectionFooterState } from "./settings-config";
import type { SettingsConfigResponse } from "./types";

type CardSaveState = { saving: boolean; error: FooterError | null; justSaved: boolean };

const IDLE_SAVE_STATE: CardSaveState = { saving: false, error: null, justSaved: false };

/** Deep-enough clone: forms are only ever spread-updated, so one level of model rows suffices. */
function cloneProviderForm(form: ProviderForm): ProviderForm {
  return { ...form, models: form.models.map((model) => ({ ...model })) };
}

/**
 * Adopt a config-derived form into an existing card: keep the card's form id
 * and reuse model-row ids where the modelId matches, so React keys (and the
 * expanded/catalog bookkeeping keyed on them) stay stable across refreshes.
 * Spread-updates only — serializeProviderForm depends on stable key order.
 */
function adoptDerivedForm(card: ProviderCard, derived: ProviderForm): ProviderForm {
  const usedRowIds = new Set<string>();
  const models = derived.models.map((model) => {
    const existing = card.form.models.find(
      (row) => row.modelId === model.modelId && !usedRowIds.has(row.id)
    );
    if (!existing) return model;
    usedRowIds.add(existing.id);
    return { ...model, id: existing.id };
  });
  return { ...derived, id: card.form.id, models };
}

/**
 * Reconcile the card list with a fresh config. Cards match derived providers
 * by identity key `form.originalName || form.id`: clean cards re-derive form
 * and baseline; dirty cards keep their connection edits, take the saved
 * models (a saved provider's models are saved as they change, so the config
 * holds them; a model action builds on them) and re-derive the baseline;
 * unsaved local cards (baseline null) are always kept; saved cards that
 * vanished from the config are dropped; unmatched derived providers append.
 */
function reconcileCards(prev: ProviderCard[], config: SettingsConfigResponse): ProviderCard[] {
  const derivedForms = providerFormsFromConfig(config);
  const derivedByName = new Map(derivedForms.map((form) => [form.originalName, form]));
  const matchedNames = new Set<string>();
  const next: ProviderCard[] = [];
  for (const card of prev) {
    const key = card.form.originalName || card.form.id;
    const derived = derivedByName.get(key);
    if (!derived) {
      if (card.baseline === null) next.push(card);
      continue;
    }
    matchedNames.add(derived.originalName);
    const clean =
      card.baseline !== null &&
      serializeProviderForm(card.form) === serializeProviderForm(card.baseline);
    if (clean) {
      const form = adoptDerivedForm(card, derived);
      next.push({ form, baseline: cloneProviderForm(form) });
    } else {
      const { models } = adoptDerivedForm(card, derived);
      next.push({ form: { ...card.form, models }, baseline: cloneProviderForm(derived) });
    }
  }
  for (const derived of derivedForms) {
    if (matchedNames.has(derived.originalName)) continue;
    next.push({ form: derived, baseline: cloneProviderForm(derived) });
  }
  return next;
}

/** `onSaved` hears each provider save that landed, with the saved name and form. */
export function useProviderCards({ onSaved }: { onSaved?: (providerName: string, saved: ProviderForm) => void } = {}) {
  const { config, savePatch } = useSettingsConfig();
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  });
  const [cards, setCards] = useState<ProviderCard[]>([]);
  const [saveStates, setSaveStates] = useState<Record<string, CardSaveState>>({});
  // Pane-level write lock. Every save/delete POSTs the WHOLE providers record,
  // built from the click-time `cards`; letting a second card save while one is
  // in flight would build its patch from pre-save baselines and silently
  // revert (or, for a just-saved new provider, delete) the first write. While
  // any save or delete is in flight the ref guards every entry point
  // synchronously (so a queued click can't slip through) and the state
  // disables the other cards' Save buttons, all delete actions and the
  // models' saves (dialogs' Save and Add, a model's Remove).
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const justSavedTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Rebase on config change, same pattern as useSaveUnit in settings-config.
  useEffect(() => {
    if (!config) return;
    setCards((prev) => reconcileCards(prev, config));
  }, [config]);

  useEffect(
    () => () => {
      for (const timer of justSavedTimersRef.current.values()) clearTimeout(timer);
    },
    []
  );

  const patchSaveState = useCallback((cardId: string, patch: Partial<CardSaveState>) => {
    setSaveStates((prev) => ({
      ...prev,
      [cardId]: { ...(prev[cardId] ?? IDLE_SAVE_STATE), ...patch }
    }));
  }, []);

  const updateForm = (cardId: string, next: ProviderForm) => {
    setCards((prev) =>
      prev.map((card) => (card.form.id === cardId ? { ...card, form: next } : card))
    );
  };

  const appendCard = (templateId: ProviderSetupTemplateId): ProviderForm => {
    const form = makeNewProvider(
      cards.map((card) => card.form),
      templateId
    );
    setCards((prev) => [...prev, { form, baseline: null }]);
    return form;
  };

  const saveCard = (cardId: string) => {
    const card = cards.find((item) => item.form.id === cardId);
    if (!card || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const snapshot = card.form;
    const savedName = providerKey(snapshot);
    patchSaveState(cardId, { saving: true, error: null, justSaved: false });
    void (async () => {
      let sent = false;
      try {
        const patch = buildProvidersPatch(cards, { savedId: cardId });
        sent = true;
        const savedConfig = await savePatch(patch);
        // The address as the server keeps it (trimmed; an empty one may be
        // filled in): what the baseline, the field and the check go by. One
        // edited while the save was on its way stays as edited.
        const kept = savedConfig.models.providers[savedName];
        const savedConnection = {
          baseURL: typeof kept?.baseURL === "string" ? kept.baseURL : snapshot.baseURL,
          organizationId: typeof kept?.organizationId === "string" ? kept.organizationId : snapshot.organizationId
        };
        // Baseline promotion: the saved snapshot becomes the baseline and
        // the card's identity (originalName) moves to the saved name BEFORE
        // the config-refresh reconcile matches by originalName. Without
        // this, a just-saved new card (originalName "") would never match
        // its derived counterpart and would be duplicated.
        //
        // A name is fixed once saved, so the form's name becomes the saved one
        // too: one typed while this save was in flight never took effect, and
        // the card's title, Codex sign-in and next save all go by the name.
        setCards((prev) =>
          prev.map((item) =>
            item.form.id === cardId
              ? {
                  form: {
                    ...item.form,
                    originalName: savedName,
                    name: savedName,
                    baseURL: item.form.baseURL === snapshot.baseURL ? savedConnection.baseURL : item.form.baseURL,
                    organizationId: item.form.organizationId === snapshot.organizationId ? savedConnection.organizationId : item.form.organizationId
                  },
                  baseline: { ...cloneProviderForm(snapshot), originalName: savedName, name: savedName, ...savedConnection }
                }
              : item
          )
        );
        patchSaveState(cardId, { saving: false, error: null, justSaved: true });
        onSavedRef.current?.(savedName, { ...snapshot, originalName: savedName, name: savedName, ...savedConnection });
        const existing = justSavedTimersRef.current.get(cardId);
        if (existing) clearTimeout(existing);
        justSavedTimersRef.current.set(
          cardId,
          setTimeout(() => {
            justSavedTimersRef.current.delete(cardId);
            patchSaveState(cardId, { justSaved: false });
          }, JUST_SAVED_MS)
        );
      } catch (err) {
        patchSaveState(cardId, {
          saving: false,
          error: saveError(err, sent),
          justSaved: false
        });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    })();
  };

  /**
   * Saves a provider's models and nothing else: the patch carries the
   * provider as saved with these models, so connection edits not saved yet
   * stay edits (and the save bar stays for them). A provider not saved yet
   * only takes them into its form: its first Save sends them. Rejects on
   * failure — the caller says why.
   */
  const saveModels = async (cardId: string, models: ModelForm[]): Promise<void> => {
    const card = cards.find((item) => item.form.id === cardId);
    if (!card) return;
    const baseline = card.baseline;
    if (baseline === null) {
      updateForm(cardId, { ...card.form, models });
      return;
    }
    // The page locks what saves while a write is on its way; a click that
    // slips past the render still finds the lock.
    if (busyRef.current) throw new Error("Another save is on its way. Try again.");
    busyRef.current = true;
    setBusy(true);
    try {
      const patch = buildProvidersPatch(
        cards.map((item) => (item.form.id === cardId ? { ...item, baseline: { ...baseline, models } } : item)),
        {}
      );
      await savePatch(patch);
      setCards((prev) =>
        prev.map((item) =>
          item.form.id === cardId && item.baseline
            ? {
                form: { ...item.form, models },
                baseline: { ...item.baseline, models: models.map((model) => ({ ...model })) }
              }
            : item
        )
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  /** Throws on save failure — the caller surfaces the error. Unsaved cards drop locally. */
  const deleteCard = async (cardId: string): Promise<void> => {
    const card = cards.find((item) => item.form.id === cardId);
    if (!card || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (card.baseline !== null) {
        const patch = buildProvidersPatch(cards, { deletedId: cardId });
        await savePatch(patch);
      }
      setCards((prev) => prev.filter((item) => item.form.id !== cardId));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const setCardError = (cardId: string, error: FooterError | null) => {
    patchSaveState(cardId, { error, justSaved: false });
  };

  const footerFor = (card: ProviderCard): SectionFooterState => {
    const state = saveStates[card.form.id] ?? IDLE_SAVE_STATE;
    const dirty =
      card.baseline === null ||
      serializeProviderForm(card.form) !== serializeProviderForm(card.baseline);
    return {
      dirty,
      saving: state.saving,
      error: state.error,
      justSaved: state.justSaved,
      // Lock the other cards while any write is in flight; the in-flight
      // card's own button is already disabled via `saving` ("Saving…").
      disabled: busy && !state.saving,
      onSave: () => saveCard(card.form.id)
    };
  };

  return { cards, busy, updateForm, appendCard, saveModels, deleteCard, setCardError, footerFor };
}
