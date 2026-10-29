import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { SettingsConfigResponse, SettingsConfigUpdate } from "./types";
import { errorText } from "@shared/error-text";

export type SettingsConfigStore = {
  config: SettingsConfigResponse | null;
  loading: boolean;
  loadError: string;
  reload: () => Promise<void>;
  /** Resolves with the config the server answered with. */
  savePatch: (patch: SettingsConfigUpdate, restartReason?: string) => Promise<SettingsConfigResponse>;
  /** A save is on its way, any section's: kept here, so a section mounted
   *  again while one is still knows. */
  saving: boolean;
  restartReasons: string[];
  clearRestartReasons: () => void;
};

/** What a footer says went wrong, as an InlineError: a plain sentence, and
 *  the server's own text, when there is any, small below it. */
export type FooterError = { message: string; detail?: string };

/** The footer's error for a save. A check that failed before anything was
 *  sent is its own sentence; a sent save that failed says so, with why. */
export function saveError(err: unknown, sent: boolean): FooterError {
  return sent ? { message: "Couldn't save.", detail: errorText(err) } : { message: errorText(err) };
}

/** Footer contract consumed by SettingsSection. */
export type SectionFooterState = {
  dirty: boolean;
  saving: boolean;
  error: FooterError | null;
  justSaved: boolean;
  /** Locks the Save button without the "Saving…" label — e.g. while a sibling
   *  card's save is in flight and the pane serializes its writes. */
  disabled?: boolean;
  onSave: () => void;
};

export type SaveUnitState<T> = {
  form: T | null;
  setForm: (updater: (prev: T) => T) => void;
  /** Changes the form and saves it at once. Saves go one at a time: a change
   *  made while one is on its way is saved after it, as the form stands then,
   *  and no answer puts back a change made after it was sent. Once the last
   *  answer is in, the form is what the server keeps. */
  saveNow: (updater: (prev: T) => T) => void;
  footer: SectionFooterState;
};

export const JUST_SAVED_MS = 1600;

export const SettingsConfigContext = createContext<SettingsConfigStore | null>(null);

export function useSettingsConfig(): SettingsConfigStore {
  const store = useContext(SettingsConfigContext);
  if (!store) throw new Error("useSettingsConfig must be used within SettingsConfigProvider");
  return store;
}

/**
 * One save unit per settings section: derives its form from the shared config,
 * tracks dirtiness against a serialized baseline, and saves its own patch.
 *
 * Rebase rule: when config changes and the unit is clean, the form re-derives;
 * when dirty, the edit is kept and only the baseline re-derives, so dirtiness
 * is always judged against the freshest config. Saves (Save and saveNow) go
 * out in the order they are made, one at a time (the store queues them, so a
 * section mounted again joins the queue); the form does not re-derive while
 * they are on their way, and the latest one's answer sets it. A change made with setForm
 * while a save is on its way is replaced by that answer, as a typed edit
 * always was: keep such state outside the form.
 */
export function useSaveUnit<T>(opts: {
  derive: (config: SettingsConfigResponse) => T;
  buildPatch: (form: T, config: SettingsConfigResponse) => SettingsConfigUpdate;
  restartReason?: string;
  serialize?: (form: T) => string; // default JSON.stringify; override to ignore volatile ids
  /** Keep the form as it is when the config changes, even when it looks
   *  saved: a draft that waits for an explicit Save (a route switched on). */
  keep?: boolean;
}): SaveUnitState<T> {
  const { config, savePatch } = useSettingsConfig();
  const [form, setFormState] = useState<T | null>(null);
  // Baseline lives in state (not just a ref) so a rebase re-renders the unit
  // and `dirty` is re-judged against the fresh config immediately.
  const [baseline, setBaseline] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<FooterError | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  // Callers pass inline functions; route them through a ref so the config
  // effect only re-runs when config actually changes.
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const configRef = useRef(config);
  configRef.current = config;

  // The form as it stands, for saves that run past a render (saveNow).
  const formRef = useRef<T | null>(null);
  // Saves on their way, and the latest one's number: only its answer sets
  // the form, says Saved or says why it failed.
  const pendingRef = useRef(0);
  const seqRef = useRef(0);
  // The latest save failed: its change stays until a save lands or the form
  // changes again, even where it now matches the config.
  const failedRef = useRef(false);

  const serialize: (form: T) => string = opts.serialize ?? JSON.stringify;
  const dirty = form !== null && serialize(form) !== baseline;

  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const savingRef = useRef(false);
  const justSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!config) return;
    const { derive, serialize: customSerialize } = optsRef.current;
    const derived = derive(config);
    const nextBaseline: string = (customSerialize ?? JSON.stringify)(derived);
    // Not while saves are on their way, even for a form that matches the
    // old baseline: the form may hold a change made after the save this
    // config answers. Their last answer sets the form.
    if (!dirtyRef.current && !savingRef.current && !failedRef.current && !optsRef.current.keep) {
      setFormState(derived);
      formRef.current = derived;
    }
    setBaseline(nextBaseline);
  }, [config]);

  useEffect(
    () => () => {
      if (justSavedTimerRef.current) clearTimeout(justSavedTimerRef.current);
    },
    []
  );

  const setForm = useCallback((updater: (prev: T) => T) => {
    failedRef.current = false;
    setFormState((prev) => {
      const next = prev === null ? prev : updater(prev);
      formRef.current = next;
      return next;
    });
  }, []);

  const flashSaved = useCallback(() => {
    setJustSaved(true);
    if (justSavedTimerRef.current) clearTimeout(justSavedTimerRef.current);
    justSavedTimerRef.current = setTimeout(() => setJustSaved(false), JUST_SAVED_MS);
  }, []);

  const saveNow = useCallback((updater: (prev: T) => T) => {
    const prev = formRef.current;
    if (prev === null) return;
    const next = updater(prev);
    formRef.current = next;
    setFormState(next);
    // The patch is the form as it stands now: saves go out in the order
    // they were made (the store queues them), each a whole snapshot.
    let patch: SettingsConfigUpdate;
    try {
      patch = optsRef.current.buildPatch(next, configRef.current!);
    } catch (err) {
      setError(saveError(err, false));
      return;
    }
    const seq = ++seqRef.current;
    pendingRef.current += 1;
    savingRef.current = true;
    setSaving(true);
    savePatch(patch, optsRef.current.restartReason)
      .then(
        (answer) => {
          // A later change is on its way: its answer sets the form.
          if (seq !== seqRef.current) return;
          failedRef.current = false;
          const derived = optsRef.current.derive(answer);
          formRef.current = derived;
          setFormState(derived);
          // Saved, with it: a config that lands in the same render (a save
          // queued behind this one) still finds the form clean and rebases it.
          setBaseline((optsRef.current.serialize ?? JSON.stringify)(derived));
          setError(null);
          flashSaved();
        },
        (err: unknown) => {
          if (seq !== seqRef.current) return;
          failedRef.current = true;
          setError(saveError(err, true));
        }
      )
      .finally(() => {
        pendingRef.current -= 1;
        if (pendingRef.current > 0) return;
        savingRef.current = false;
        setSaving(false);
      });
  }, [savePatch, flashSaved]);

  // Save sends the form as it stands, through the same queue: a change
  // saveNow queues while it is on its way is sent after it, not lost.
  const onSave = useCallback(() => saveNow((prev) => prev), [saveNow]);

  const footer = useMemo<SectionFooterState>(
    () => ({ dirty, saving, error, justSaved, onSave }),
    [dirty, saving, error, justSaved, onSave]
  );

  return useMemo(() => ({ form, setForm, saveNow, footer }), [form, setForm, saveNow, footer]);
}

/** A save unit's footer exists only while it has something to say. */
export function footerHasSomethingToSay(footer: SectionFooterState): boolean {
  return footer.dirty || footer.saving || !!footer.error || footer.justSaved;
}
