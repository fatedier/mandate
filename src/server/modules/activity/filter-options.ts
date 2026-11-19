import type { Database } from "bun:sqlite";
import type { ActivityFilterOptionsResponse } from "../../../shared/api-contracts.js";
import { PROVIDER_KEY_SQL } from "./llm-call-rows.js";

/**
 * What the log can be filtered by: every model (behind its provider's name,
 * as the log's filter and the summary's groups read it) and every purpose
 * that has a call, the most recently used first, over all history, as the
 * log lists it. The models read every call, so this runs off the main
 * thread (listFilterOptionsAway).
 */
export function listActivityFilterOptions(db: Database): ActivityFilterOptionsResponse {
  const models = db.prepare(`
    select ${PROVIDER_KEY_SQL} provider, model, max(created_at) last
    from llm_calls
    group by 1, 2
    order by last desc, provider, model
  `).all() as Array<{ provider: string | null; model: string | null }>;
  const purposes = db.prepare(`
    select purpose, max(created_at) last
    from llm_calls
    where purpose <> ''
    group by purpose
    order by last desc, purpose
  `).all() as Array<{ purpose: string }>;
  return {
    models: models
      .filter((row): row is { provider: string; model: string | null } => !!row.provider)
      .map((row) => ({ provider: row.provider, model: row.model || null })),
    purposes: purposes.map((row) => row.purpose)
  };
}
