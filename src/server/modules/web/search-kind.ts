import type { Config, ResolvedProviderConfig } from "../../config.js";
import type { MandateStore } from "../../app/store.js";
import type { HttpClient } from "../../platform/http/http-client.js";

/**
 * One kind of search backend: a module that adds itself to SEARCH_KINDS.
 * Nothing else names a kind — the tool, the Settings page, the check, the
 * chat and the config all read the list — so a new service is its module.
 *
 * A kind declares the setup it needs as fields of five types the Settings
 * page knows how to draw, and searches with the values stored for them.
 */
export type SearchField = {
  key: string;
  label: string;
  description?: string;
  required: boolean;
} & (
  | {
      type: "model";
      /** Which of the installation's models the field lists. */
      accepts: (model: ResolvedProviderConfig) => boolean;
      /** A word after a model's ref in the list, such as the API it is on. */
      note?: (model: ResolvedProviderConfig) => string | undefined;
    }
  | { type: "provider"; providerTypes: readonly string[] }
  | { type: "secret" }
  | { type: "url"; placeholder?: string }
  | { type: "choice"; options: ReadonlyArray<{ value: string; label: string }>; defaultValue: string }
);

/** A kind's stored values by field key, choices filled with their defaults. */
export type SearchSetup = Readonly<Record<string, string>>;

export interface SearchItem {
  title: string;
  url: string;
  excerpt: string;
  published?: string;
  site?: string;
}

export interface SearchFindings {
  answer?: string;
  results: SearchItem[];
}

/** A search that did not work, with the reason the agent and the check are
 *  told. `status` is the service's HTTP status when it answered with one;
 *  `reply`, what a model wrote instead of searching, which only the check
 *  shows. */
export class SearchFailure extends Error {
  constructor(message: string, readonly status?: number, readonly reply?: string) {
    super(message);
  }
}

/** How long one search may take, whichever backend runs it: the same 2
 *  minutes as every model call's quiet window. */
export const SEARCH_TIMEOUT_MS = 2 * 60_000;

/** Why a search that ran out of its time failed, in the tool's result. */
export const NO_ANSWER_IN_TIME = `no answer within ${SEARCH_TIMEOUT_MS / 1000} s`;

export interface SearchCallContext {
  config: Config;
  http: HttpClient;
  /** The turn's stop (or the check's): aborts the request and is rethrown. */
  signal: AbortSignal;
  /** How long one request may take; SEARCH_TIMEOUT_MS outside tests. */
  timeoutMs: number;
  /** The pause before the one retry. */
  wait: (ms: number) => Promise<void>;
  /** Where a model call is recorded, when there is a store. */
  store: MandateStore | null;
  record: { scopeType: string; scopeId: string };
}

export interface SearchKind {
  /** Kept in the config: never changed once shipped. */
  id: string;
  label: string;
  description: string;
  fields: readonly SearchField[];
  search(setup: SearchSetup, query: string, ctx: SearchCallContext): Promise<SearchFindings>;
  /** The short name the chat and the check show. */
  describe(setup: SearchSetup): string;
}

/** At most this many results reach the agent. */
export const MAX_SEARCH_RESULTS = 10;

export function setupOf(kind: SearchKind, config: Config): SearchSetup {
  const stored = config.webSearch.kinds[kind.id] ?? {};
  const setup: Record<string, string> = {};
  for (const field of kind.fields) {
    const value = stored[field.key]?.trim() ?? "";
    if (value) setup[field.key] = value;
    else if (field.type === "choice") setup[field.key] = field.defaultValue;
  }
  return setup;
}

export function isSetUp(kind: SearchKind, config: Config): boolean {
  const setup = setupOf(kind, config);
  return kind.fields.every((field) => !field.required || Boolean(setup[field.key]));
}

/** A result list as a service sent it: entries with an address, at most ten. */
export function searchItems(entries: unknown, read: (entry: Record<string, unknown>) => SearchItem | null): SearchItem[] {
  if (!Array.isArray(entries)) return [];
  const items: SearchItem[] = [];
  for (const entry of entries) {
    if (items.length >= MAX_SEARCH_RESULTS) break;
    if (!entry || typeof entry !== "object") continue;
    const item = read(entry as Record<string, unknown>);
    const url = item?.url.trim() ?? "";
    if (item && url) items.push({ ...item, url });
  }
  return items;
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function optionalText<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  return typeof value === "string" && value.trim() ? ({ [key]: value.trim() } as Record<K, string>) : {};
}
