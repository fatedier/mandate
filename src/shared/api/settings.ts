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
