import type { ModelInputType, SettingsConfigPayload } from "../settings.js";
import type { ApiErrorResponse } from "./common.js";

export type SettingsConfigResponseEnvelope = ({
  ok: true;
} & SettingsConfigPayload) | ApiErrorResponse;

export interface ProviderModelCatalogItem {
  id: string;
  name: string;
  input: ModelInputType[];
  supportsReasoning?: boolean;
  contextLength: number | null;
  outputModalities: string[];
  supportedParameters: string[];
  /** What the provider's own model list declares, only when it declares it
   *  (OpenRouter-shaped lists such as kilo's): false = the list says the model
   *  lacks it. Drives the editor's source note. */
  declared?: { image?: boolean; reasoning?: boolean };
}

type ProviderModelCatalogSource = "builtin" | "configured" | "live";

export type ProviderModelsResponseEnvelope = ({
  ok: true;
  providerName: string;
  providerType: string;
  source: ProviderModelCatalogSource;
  cached: boolean;
  models: ProviderModelCatalogItem[];
}) | ApiErrorResponse;

/** A provider's check: its model list read with the saved settings (no
 *  prompt is sent). Codex is its sign-in; a provider without a key is not
 *  checked. */
export type ProviderCheckResult =
  | { result: "ready"; modelCount: number; checkedAt: string }
  | { result: "failed"; message: string; httpStatus?: number; checkedAt: string }
  | { result: "unchecked"; reason: "no-key" | "signed-in-only" };

export type ProviderCheckResponseEnvelope = ({ ok: true; providerName: string } & ProviderCheckResult) | ApiErrorResponse;

/** The Web search check: one real search with the saved settings. Works:
 *  how many pages, how long, the answer (a few lines) and the first pages.
 *  Failed: why, and what a model wrote instead of searching. */
export type WebSearchCheckResult =
  | { result: "works"; count: number; ms: number; answer?: string; top: Array<{ title: string; url: string }> }
  | { result: "failed"; message: string; reply?: string };

export type WebSearchCheckResponseEnvelope = ({ ok: true } & WebSearchCheckResult) | ApiErrorResponse;
