import type { SearchSelectOption } from "@/components/ui/search-select";
import type { ActivityFilterOptionsResponse } from "@shared/api-contracts";
import type { ActivityCall } from "../types";

/** The log's model filter: each provider by its connection, as the server
 *  groups and filters.
 *  The chosen one first, then every model the log has (`known`, from the
 *  server, most recently used first), then any the loaded rows add (they
 *  stand in while `known` is on its way, or if it failed). */
export function buildModelOptions(
  calls: ActivityCall[],
  activeProvider: string | null,
  activeModel: string | null,
  known: ActivityFilterOptionsResponse["models"] = []
): SearchSelectOption[] {
  const seen = new Set<string>();
  const options: SearchSelectOption[] = [{ value: "", label: "Any model" }];
  const add = (provider: string | null, model: string | null) => {
    if (!provider) return;
    const value = providerModelValue(provider, model);
    if (seen.has(value)) return;
    seen.add(value);
    options.push({ value, label: model ? `${provider} / ${model}` : provider });
  };
  add(activeProvider, activeModel);
  for (const entry of known) add(entry.provider, entry.model);
  for (const call of calls) add(call.providerName, call.model);
  return options;
}

/** The log's purpose filter, in the same order: the chosen one, every
 *  purpose the log has, then any the loaded rows add. */
export function buildPurposeOptions(
  calls: ActivityCall[],
  active: string | null,
  known: ActivityFilterOptionsResponse["purposes"] = []
): SearchSelectOption[] {
  const seen = new Set<string>();
  const options: SearchSelectOption[] = [{ value: "", label: "Any purpose" }];
  const add = (purpose: string | null | undefined) => {
    const name = purpose?.trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    options.push({ value: name, label: name });
  };
  add(active);
  for (const purpose of known) add(purpose);
  for (const call of calls) add(call.purpose);
  return options;
}

export function providerModelValue(provider: string | null, model: string | null): string {
  if (!provider) return "";
  return JSON.stringify([provider, model]);
}

export function parseProviderModelValue(value: string): { provider: string | null; model: string | null } {
  if (!value) return { provider: null, model: null };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string") {
      return { provider: null, model: null };
    }
    return {
      provider: parsed[0],
      model: typeof parsed[1] === "string" ? parsed[1] : null
    };
  } catch {
    return { provider: null, model: null };
  }
}
