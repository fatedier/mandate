import type { Config } from "../../config.js";
import type { MandateStore } from "../../app/store.js";
import { globalHttpClient, type HttpClient } from "../../platform/http/http-client.js";
import { errorText } from "../../../shared/error-text.js";
import type { WebSearchCheckResult } from "../../../shared/api/settings.js";
import { SEARCH_KINDS } from "./kinds/index.js";
import { isSetUp, SEARCH_TIMEOUT_MS, SearchFailure, setupOf, type SearchFindings, type SearchKind, type SearchSetup } from "./search-kind.js";

/** No kind is chosen and set up: the tool is not offered then, so only the
 *  check meets this. */
export class NothingChosen extends Error {
  constructor() {
    super("web search is not set up");
  }
}

/** A search that failed, worded as the agent is told it. `reply`: what a
 *  model wrote instead of searching, for the check alone. */
export class WebSearchFailed extends Error {
  constructor(readonly backend: string, readonly reason: string, readonly reply?: string) {
    super(`Web search failed (${backend}): ${reason.replace(/\.$/, "")}.`);
  }
}

export interface WebSearchDeps {
  getConfig: () => Config;
  store?: MandateStore | null;
  http?: HttpClient;
  /** Every kind there is; a test adds its own. */
  kinds?: readonly SearchKind[];
  now?: () => number;
  timeoutMs?: number;
  wait?: (ms: number) => Promise<void>;
}

export interface WebSearchService {
  /** The kind chosen in Settings and its setup; null when search is off,
   *  names a kind this build lacks, or the kind is not set up. */
  chosen(): { kind: SearchKind; setup: SearchSetup } | null;
  search(query: string, opts: { signal?: AbortSignal; record: { scopeType: string; scopeId: string } }): Promise<{ backend: string; findings: SearchFindings; ms: number }>;
}

export function createWebSearch(deps: WebSearchDeps): WebSearchService {
  const kinds = deps.kinds ?? SEARCH_KINDS;
  const now = deps.now ?? Date.now;
  const chosen = () => {
    const config = deps.getConfig();
    const kind = kinds.find((k) => k.id === config.webSearch.use);
    return kind && isSetUp(kind, config) ? { kind, setup: setupOf(kind, config) } : null;
  };
  return {
    chosen,
    async search(query, opts) {
      const picked = chosen();
      if (!picked) throw new NothingChosen();
      const signal = opts.signal ?? new AbortController().signal;
      const backend = picked.kind.describe(picked.setup);
      const startedAt = now();
      try {
        const findings = await picked.kind.search(picked.setup, query, {
          config: deps.getConfig(),
          http: deps.http ?? globalHttpClient,
          signal,
          timeoutMs: deps.timeoutMs ?? SEARCH_TIMEOUT_MS,
          wait: deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
          store: deps.store ?? null,
          record: opts.record
        });
        return { backend, findings, ms: now() - startedAt };
      } catch (error) {
        // A stop is the turn's, not the search's.
        if (signal.aborted) throw error;
        throw new WebSearchFailed(backend, errorText(error, "the search failed"), error instanceof SearchFailure ? error.reply : undefined);
      }
    }
  };
}

/** The fixed query the Settings check searches for: one any backend finds,
 *  about something current, so a model left to choose whether to search does. */
export const CHECK_QUERY = "What is the latest stable version of Python?";

export type { WebSearchCheckResult };

/** What the check shows of an answer or a model's reply: a few lines. */
const CHECK_TEXT_MAX = 400;
/** The pages the check shows. */
const CHECK_PAGES = 3;

/** One real search, as the Settings check runs it, recorded apart from the
 *  agents' searches. It is the user's look at the search: what came back (the
 *  answer and the first pages), or what a model wrote instead of searching. */
export async function checkWebSearch(service: WebSearchService): Promise<WebSearchCheckResult> {
  try {
    const { findings, ms } = await service.search(CHECK_QUERY, { record: { scopeType: "settings", scopeId: "web_search" } });
    const answer = checkText(findings.answer);
    return {
      result: "works",
      count: findings.results.length,
      ms,
      ...(answer ? { answer } : {}),
      top: findings.results.slice(0, CHECK_PAGES).map(({ title, url }) => ({ title, url }))
    };
  } catch (error) {
    if (error instanceof NothingChosen) return { result: "failed", message: "Not set up" };
    if (error instanceof WebSearchFailed) {
      const reply = checkText(error.reply);
      return { result: "failed", message: error.reason, ...(reply ? { reply } : {}) };
    }
    return { result: "failed", message: errorText(error, "the search failed") };
  }
}

/** One line, its runs of whitespace one space, cut to what a few lines hold. */
function checkText(text: string | undefined): string {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  const chars = [...line];
  return chars.length > CHECK_TEXT_MAX ? `${chars.slice(0, CHECK_TEXT_MAX).join("").trimEnd()}…` : line;
}
