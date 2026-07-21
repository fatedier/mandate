import { describe, expect, test } from "bun:test";
import { buildEmbeddingPatch } from "@/routes/settings/memory-settings-model";
import { buildVoicePayload, type VoiceForm } from "@/routes/settings/voice-settings-model";

describe("buildEmbeddingPatch", () => {
  test("builds exactly the memory.embedding.model patch", () => {
    expect(buildEmbeddingPatch({ model: "openai/text-embedding-3-small" })).toEqual({
      memory: { embedding: { model: "openai/text-embedding-3-small" } }
    });
  });
});

describe("buildVoicePayload", () => {
  const form: VoiceForm = {
    provider: "openai",
    model: "gpt-realtime-mini",
    voice: "marin",
    language: "en",
    baseURL: "",
    deployment: "",
    idleTimeoutMinutes: "5",
    maxSessionMinutes: "30",
    contextMessageCount: "12",
    apiKey: "",
    clearApiKey: false
  };

  test("converts valid minutes to milliseconds", () => {
    const patch = buildVoicePayload(form);
    expect(patch.voice?.idleTimeoutMs).toBe(5 * 60_000);
    expect(patch.voice?.maxSessionMs).toBe(30 * 60_000);
  });

  test("rejects a non-numeric idle timeout", () => {
    expect(() => buildVoicePayload({ ...form, idleTimeoutMinutes: "soon" })).toThrow(
      "Idle timeout must be a non-negative number."
    );
  });
});
