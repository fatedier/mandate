import type { SettingsConfigResponse, SettingsConfigUpdate } from "./types";

/** Exact patch for the embeddings unit — nothing but the embedding model. */
export function buildEmbeddingPatch(form: { model: string }): SettingsConfigUpdate {
  return { memory: { embedding: { model: form.model } } };
}

export type MemorySettingsFormState = {
  dreamEnabled: boolean;
};

export function formFromConfig(config: SettingsConfigResponse): MemorySettingsFormState {
  return {
    dreamEnabled: config.memory.dream.enabled
  };
}

export function buildMemoryPayload(form: MemorySettingsFormState): SettingsConfigUpdate {
  return {
    memory: {
      dream: {
        enabled: form.dreamEnabled
      }
    }
  };
}
