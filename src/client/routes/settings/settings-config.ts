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

export type SettingsConfigStore = {
  config: SettingsConfigResponse | null;
  loading: boolean;
  loadError: string;
  reload: () => Promise<void>;
  savePatch: (patch: SettingsConfigUpdate, restartReason?: string) => Promise<void>;
  restartReasons: string[];
  clearRestartReasons: () => void;
};

/** Footer contract consumed by SettingsSection (Task 3). */
export type SectionFooterState = {
  dirty: boolean;
  saving: boolean;
  error: string;
  justSaved: boolean;
  /** Locks the Save button without the "Saving…" label — e.g. while a sibling
   *  card's save is in flight and the pane serializes its writes. */
  disabled?: boolean;
  onSave: () => void;
};

export type SaveUnitState<T> = {
  form: T | null;
  setForm: (updater: (prev: T) => T) => void;
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
 * is always judged against the freshest config.
 */
export function useSaveUnit<T>(opts: {
  derive: (config: SettingsConfigResponse) => T;
  buildPatch: (form: T, config: SettingsConfigResponse) => SettingsConfigUpdate;
  restartReason?: string;
  serialize?: (form: T) => string; // default JSON.stringify; override to ignore volatile ids
}): SaveUnitState<T> {
  const { config, savePatch } = useSettingsConfig();
  const [form, setFormState] = useState<T | null>(null);
  // Baseline lives in state (not just a ref) so a rebase re-renders the unit
  // and `dirty` is re-judged against the fresh config immediately.
  const [baseline, setBaseline] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [justSaved, setJustSaved] = useState(false);

  // Callers pass inline functions; route them through a ref so the config
  // effect only re-runs when config actually changes.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const serialize: (form: T) => string = opts.serialize ?? JSON.stringify;
  const dirty = form !== null && serialize(form) !== baseline;

  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const rederiveRef = useRef(false);
  const savingRef = useRef(false);
  const justSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!config) return;
    const { derive, serialize: customSerialize } = optsRef.current;
    const derived = derive(config);
    const nextBaseline: string = (customSerialize ?? JSON.stringify)(derived);
    if (!dirtyRef.current || rederiveRef.current) {
      setFormState(derived);
      rederiveRef.current = false;
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
    setFormState((prev) => (prev === null ? prev : updater(prev)));
  }, []);

  const onSave = useCallback(() => {
    if (form === null || config === null || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    void (async () => {
      try {
        const patch = optsRef.current.buildPatch(form, config);
        // The save response is a config change; force the unit (still dirty
        // at that point) to re-derive from it instead of keeping the edit.
        rederiveRef.current = true;
        await savePatch(patch, optsRef.current.restartReason);
        setError("");
        setJustSaved(true);
        if (justSavedTimerRef.current) clearTimeout(justSavedTimerRef.current);
        justSavedTimerRef.current = setTimeout(() => setJustSaved(false), JUST_SAVED_MS);
      } catch (err) {
        rederiveRef.current = false;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    })();
  }, [form, config, savePatch]);

  const footer = useMemo<SectionFooterState>(
    () => ({ dirty, saving, error, justSaved, onSave }),
    [dirty, saving, error, justSaved, onSave]
  );

  return useMemo(() => ({ form, setForm, footer }), [form, setForm, footer]);
}
