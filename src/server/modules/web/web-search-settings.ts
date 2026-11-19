import type { Config } from "../../config.js";
import { resolveModelSelection } from "../../config/model-resolution.js";
import type { WebSearchFieldSettings, WebSearchSettingsConfig } from "../../../shared/settings.js";
import { isJsonObject, type JsonObject } from "../settings/config-normalizers.js";
import { sectionFor } from "../settings/config-patch-helpers.js";
import { SEARCH_KINDS } from "./kinds/index.js";
import { listedModelRefs } from "./kinds/model-search.js";
import { isSetUp, type SearchField, type SearchKind } from "./search-kind.js";

/**
 * The Web search section as the Settings page draws it: every kind in the
 * list, each with its own fields — their values as saved, a secret only as
 * whether one is saved, the options a field offers. The page knows no kind.
 */
export function webSearchSettings(config: Config, kinds: readonly SearchKind[] = SEARCH_KINDS): WebSearchSettingsConfig {
  const use = kinds.some((kind) => kind.id === config.webSearch.use) ? config.webSearch.use : "off";
  return {
    use,
    kinds: kinds.map((kind) => ({
      id: kind.id,
      label: kind.label,
      description: kind.description,
      setUp: isSetUp(kind, config),
      fields: kind.fields.map((field) => fieldSettings(field, config.webSearch.kinds[kind.id]?.[field.key]?.trim() ?? "", config))
    }))
  };
}

function fieldSettings(field: SearchField, stored: string, config: Config): WebSearchFieldSettings {
  const base = {
    key: field.key,
    type: field.type,
    label: field.label,
    ...(field.description ? { description: field.description } : {}),
    required: field.required
  };
  switch (field.type) {
    case "secret":
      return { ...base, value: "", configured: Boolean(stored) };
    case "choice":
      return { ...base, value: stored || field.defaultValue, options: field.options };
    case "url":
      return { ...base, value: stored, ...(field.placeholder ? { placeholder: field.placeholder } : {}) };
    case "model": {
      const options = listedModelRefs(config).flatMap((ref) => {
        const model = resolveModelSelection(config, { model: ref, reasoningEffort: "provider-default" });
        if (!field.accepts(model)) return [];
        const note = field.note?.(model);
        return [{ value: ref, label: note ? `${ref} · ${note}` : ref }];
      });
      return { ...base, value: stored, options: withStored(options, stored) };
    }
    case "provider": {
      const options = Object.entries(config.models.providers)
        .filter(([, provider]) => field.providerTypes.includes(provider.type))
        .map(([name]) => ({ value: name, label: name }));
      return { ...base, value: stored, options: withStored(options, stored) };
    }
  }
}

/** A saved value the list no longer has stays first, as it is. */
function withStored(options: Array<{ value: string; label: string }>, stored: string) {
  return stored && !options.some((option) => option.value === stored) ? [{ value: stored, label: stored }, ...options] : options;
}

/**
 * A save from the page: `use` is "off" or a kind's id; each kind's values by
 * field. A secret: a string sets it, a blank keeps the saved one, null
 * removes it. Any other field: a string sets it, a blank or null removes it.
 * An address must be http(s); a choice one of its options. Kinds the patch
 * leaves out — a kind this build lacks among them — are kept.
 */
export function applyWebSearchPatch(root: JsonObject, patch: unknown, kinds: readonly SearchKind[] = SEARCH_KINDS): void {
  if (!isJsonObject(patch)) throw new Error("web search settings must be an object");
  const section = sectionFor(root, "webSearch");
  if (Object.hasOwn(patch, "use")) {
    const use = patch.use === null ? "off" : patch.use;
    if (typeof use !== "string") throw new Error("use must be a string");
    const trimmed = use.trim() || "off";
    if (trimmed !== "off" && !kinds.some((kind) => kind.id === trimmed)) throw new Error("webSearch.use is not supported");
    section.use = trimmed;
  }
  if (Object.hasOwn(patch, "kinds")) {
    if (!isJsonObject(patch.kinds)) throw new Error("kinds must be an object");
    const saved: JsonObject = isJsonObject(section.kinds) ? { ...section.kinds } : {};
    for (const [id, values] of Object.entries(patch.kinds)) {
      const kind = kinds.find((k) => k.id === id);
      if (!kind) throw new Error(`${id} is not supported`);
      if (!isJsonObject(values)) throw new Error(`${id} must be an object`);
      const target: JsonObject = isJsonObject(saved[id]) ? { ...(saved[id] as JsonObject) } : {};
      for (const [key, value] of Object.entries(values)) {
        const field = kind.fields.find((f) => f.key === key);
        if (!field) throw new Error(`${key} is not supported`);
        setFieldValue(target, field, value);
      }
      saved[id] = target;
    }
    section.kinds = saved;
  }
}

function setFieldValue(target: JsonObject, field: SearchField, value: unknown): void {
  if (value === null) {
    delete target[field.key];
    return;
  }
  if (typeof value !== "string") throw new Error(`${field.key} must be a string`);
  const trimmed = value.trim();
  if (field.type === "secret") {
    if (trimmed) target[field.key] = trimmed;
    return;
  }
  if (!trimmed) {
    delete target[field.key];
    return;
  }
  if (field.type === "url" && !isHttpAddress(trimmed)) throw new Error(`${field.label} must be an http or https address`);
  if (field.type === "choice" && !field.options.some((option) => option.value === trimmed)) throw new Error(`${field.key} is not supported`);
  target[field.key] = trimmed;
}

function isHttpAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** The section leaves the file when it holds nothing: off, no values. */
export function pruneWebSearchSection(root: JsonObject): void {
  const section = root.webSearch;
  if (!isJsonObject(section)) return;
  if (isJsonObject(section.kinds)) {
    for (const [id, values] of Object.entries(section.kinds)) {
      if (isJsonObject(values) && Object.keys(values).length === 0) delete section.kinds[id];
    }
    if (Object.keys(section.kinds).length === 0) delete section.kinds;
  }
  if ((section.use === undefined || section.use === "off") && section.kinds === undefined) delete root.webSearch;
}
