import type { SimpleSelectOption } from "@/components/ui/select";
import type { ActivityCall } from "../types";

/** The log's model filter: each provider by its name from Settings (the
 *  family for an older row with none), as the server groups and filters. */
export function buildModelOptions(
  calls: ActivityCall[],
  activeProvider: string | null,
  activeModel: string | null
): SimpleSelectOption[] {
  const seen = new Set<string>();
  const options: SimpleSelectOption[] = [{ value: "", label: "Any model" }];
  if (activeProvider) {
    const value = providerModelValue(activeProvider, activeModel);
    seen.add(value);
    options.push({
      value,
      label: activeModel ? `${activeProvider} / ${activeModel}` : activeProvider
    });
  }
  for (const call of calls) {
    const provider = call.providerName ?? call.provider;
    if (!provider) continue;
    const value = providerModelValue(provider, call.model);
    if (seen.has(value)) continue;
    seen.add(value);
    options.push({
      value,
      label: call.model ? `${provider} / ${call.model}` : provider
    });
  }
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
