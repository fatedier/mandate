import type { ModelRefDto, ThreadModelDto } from "@shared/api-contracts";

/** A model as the composer names it: what follows its last slash
 *  ("anthropic/claude-opus-5-5" → "claude-opus-5-5"). */
export function shortModelName(model: string): string {
  return model.slice(model.lastIndexOf("/") + 1);
}

/** The model the composer names: the one the running turn calls now, else
 *  the thread's pick, else its Default. */
export function shownModel(state: ThreadModelDto, live: ModelRefDto | null): ModelRefDto {
  return live ?? state.override ?? state.default;
}

/** Its name, with its provider when that is not the Default's (a fallback's
 *  or a pick's of the same name elsewhere would read the same without it). */
export function modelLabel(state: ThreadModelDto, live: ModelRefDto | null): string {
  const shown = shownModel(state, live);
  const name = shortModelName(shown.model);
  return shown.providerName && shown.providerName !== state.default.providerName ? `${name} · ${shown.providerName}` : name;
}

/** A choice's name in the list: short, unless another model of its provider
 *  has the same short name. */
export function choiceName(model: ModelRefDto, providerModels: readonly ModelRefDto[]): string {
  const short = shortModelName(model.model);
  const clash = providerModels.some((other) => other.ref !== model.ref && shortModelName(other.model) === short);
  return clash ? model.model : short;
}
