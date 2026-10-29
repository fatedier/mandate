import { expect, test } from "bun:test";
import { providerOptionsWithReasoningForAiSdk, reasoningOn } from "../src/server/modules/llm/reasoning.js";

// Capabilities default on: reasoning is on unless a model is
// marked off, and "on" makes an OpenAI-style model a reasoning one for the AI
// SDK whatever the effort.

test("reasoning is on unless marked off", () => {
  expect([reasoningOn(undefined), reasoningOn(true), reasoningOn(false)]).toEqual([true, true, false]);
});

test("an OpenAI-style model with reasoning on is forced a reasoning one, whatever the effort", () => {
  for (const provider of ["openai", "openai-compatible", "codex", "openai.responses", "codex.responses"]) {
    expect([provider, providerOptionsWithReasoningForAiSdk(undefined, provider, undefined)?.openai?.forceReasoning]).toEqual([provider, true]);
    expect([provider, providerOptionsWithReasoningForAiSdk(undefined, provider, true)?.openai?.forceReasoning]).toEqual([provider, true]);
  }
});

test("reasoning off, or a provider that is not OpenAI-style, leaves the options as they were", () => {
  const existing = { openai: { store: false } };
  expect(providerOptionsWithReasoningForAiSdk(existing, "openai-compatible", false)).toBe(existing);
  for (const provider of ["kilo", "anthropic", "google"]) {
    expect([provider, providerOptionsWithReasoningForAiSdk(existing, provider, undefined)]).toEqual([provider, existing]);
  }
});

test("forcing keeps the other OpenAI options", () => {
  expect(providerOptionsWithReasoningForAiSdk({ openai: { store: false, promptCacheKey: "t1" } }, "openai", undefined))
    .toEqual({ openai: { store: false, promptCacheKey: "t1", forceReasoning: true } });
});
