/**
 * Which API each Kilo Gateway model runs on, as Kilo itself says: its /models
 * list tags a model with the SDK its own client builds it with
 * (`opencode.ai_sdk_provider`). A model tagged `anthropic` speaks Messages,
 * `openai` Responses; anything else, or a model Kilo has not tagged or that
 * is not known here, runs on Chat, which every Kilo model answers.
 *
 * Kept per connection, in memory, for model resolution to read synchronously;
 * kilo-model-apis-refresh.ts fills it from the saved copy and the network.
 */
export type KiloApi = "messages" | "responses" | "chat";

/** Only the models that are not on Chat, per connection name. */
const byConnection = new Map<string, Map<string, KiloApi>>();

export function kiloApiOfTag(tag: unknown): KiloApi {
  if (tag === "anthropic") return "messages";
  if (tag === "openai") return "responses";
  return "chat";
}

/** The models of a /models answer that are not on Chat, by id; null when the
 *  answer is not a model list. */
export function kiloApisOfListing(payload: unknown): Map<string, KiloApi> | null {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const apis = new Map<string, KiloApi>();
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const opencode = entry.opencode && typeof entry.opencode === "object" ? entry.opencode as Record<string, unknown> : {};
    const api = kiloApiOfTag(opencode.ai_sdk_provider);
    if (id && api !== "chat") apis.set(id, api);
  }
  return apis;
}

export function kiloModelApi(connection: string, modelId: string): KiloApi {
  return byConnection.get(connection)?.get(modelId) ?? "chat";
}

/** Replaces a connection's tags; true when any model's API changed. */
export function replaceKiloModelApis(connection: string, apis: ReadonlyMap<string, KiloApi>): boolean {
  const next = new Map([...apis].filter(([, api]) => api !== "chat"));
  const current = byConnection.get(connection) ?? new Map<string, KiloApi>();
  const changed = current.size !== next.size || [...next].some(([id, api]) => current.get(id) !== api);
  if (next.size === 0) byConnection.delete(connection);
  else byConnection.set(connection, next);
  return changed;
}

export function kiloModelApisSnapshot(): Record<string, Record<string, KiloApi>> {
  return Object.fromEntries([...byConnection].map(([connection, apis]) => [connection, Object.fromEntries(apis)]));
}

/** Restores a saved snapshot (connections it does not name are left alone);
 *  true when anything changed. Anything that is not a snapshot changes nothing. */
export function restoreKiloModelApis(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== "object") return false;
  let changed = false;
  for (const [connection, models] of Object.entries(snapshot as Record<string, unknown>)) {
    if (!models || typeof models !== "object") continue;
    const apis = new Map<string, KiloApi>();
    for (const [id, api] of Object.entries(models as Record<string, unknown>)) {
      if (api === "messages" || api === "responses") apis.set(id, api);
    }
    if (replaceKiloModelApis(connection, apis)) changed = true;
  }
  return changed;
}

/** Forgets every tag (tests). */
export function clearKiloModelApis(): void {
  byConnection.clear();
}
