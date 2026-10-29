import type { SettingsConfigResponse, SettingsConfigUpdate, WebSearchSettingsConfig } from "./types";

/** The page's form: the choice, each kind's values by field, and each
 *  secret's draft (a new key; blank keeps the saved one) or its removal. */
export type WebSearchForm = {
  use: string;
  values: Record<string, Record<string, string>>;
  secrets: Record<string, Record<string, { draft: string; remove: boolean }>>;
};

export function webSearchFormFromConfig(config: SettingsConfigResponse): WebSearchForm {
  const section = config.webSearch;
  const form: WebSearchForm = { use: section.use, values: {}, secrets: {} };
  for (const kind of section.kinds) {
    form.values[kind.id] = {};
    form.secrets[kind.id] = {};
    for (const field of kind.fields) {
      if (field.type === "secret") form.secrets[kind.id]![field.key] = { draft: "", remove: false };
      else form.values[kind.id]![field.key] = field.value;
    }
  }
  return form;
}

/** The choice, and for each kind what changed: values that differ from
 *  what is saved, a typed key, a key removed (null). */
export function buildWebSearchPatch(form: WebSearchForm, config: SettingsConfigResponse): SettingsConfigUpdate {
  const saved = webSearchFormFromConfig(config);
  const kinds: Record<string, Record<string, string | null>> = {};
  for (const kind of config.webSearch.kinds) {
    const changes: Record<string, string | null> = {};
    for (const field of kind.fields) {
      if (field.type === "secret") {
        const secret = form.secrets[kind.id]?.[field.key];
        if (secret?.remove) changes[field.key] = null;
        else if (secret?.draft.trim()) changes[field.key] = secret.draft.trim();
      } else {
        const value = form.values[kind.id]?.[field.key] ?? "";
        if (value !== (saved.values[kind.id]?.[field.key] ?? "")) changes[field.key] = value;
      }
    }
    if (Object.keys(changes).length > 0) kinds[kind.id] = changes;
  }
  return { webSearch: { use: form.use, ...(Object.keys(kinds).length > 0 ? { kinds } : {}) } };
}

export type WebSearchStatus =
  | { tone: "idle"; label: "Off" }
  | { tone: "ready"; label: "Ready" }
  | { tone: "attention"; label: "Not set up" };

/** What is saved: off (or a kind this build lacks), a kind set up, or one
 *  still missing a required field. Whether it works is the check's to say. */
export function webSearchStatus(config: SettingsConfigResponse): WebSearchStatus {
  const kind = chosenKind(config.webSearch, config.webSearch.use);
  if (!kind) return { tone: "idle", label: "Off" };
  return kind.setUp ? { tone: "ready", label: "Ready" } : { tone: "attention", label: "Not set up" };
}

export function chosenKind(section: WebSearchSettingsConfig, use: string) {
  return use === "off" ? null : section.kinds.find((kind) => kind.id === use) ?? null;
}

/** "Search works: N results in T s", T to one decimal; "answer only" for an
 *  answer that named no pages. */
export function checkWorksText(count: number, ms: number, answered = false): string {
  const seconds = (ms / 1000).toFixed(1);
  // An answer that named no pages is not no results.
  if (count === 0 && answered) return `Search works: answer only, in ${seconds} s`;
  return `Search works: ${count} ${count === 1 ? "result" : "results"} in ${seconds} s`;
}
