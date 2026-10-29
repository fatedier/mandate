import { expect, test } from "bun:test";
import {
  setCodexServiceTier,
  setModelRef,
  setPositiveNumber,
  setProviderModels,
  setString
} from "../src/server/modules/settings/config-patch-helpers.js";

test("a settings patch keeps a key it leaves out, and null removes one", () => {
  const target: Record<string, unknown> = { name: "a", other: "b" };
  setString(target, { name: null }, "name");
  setString(target, {}, "other");
  expect(target).toEqual({ other: "b" });
});

test("an empty string clears a model, a number and a service tier", () => {
  const target: Record<string, unknown> = { model: "openai/gpt-5", limit: 5, serviceTier: "flex" };
  setModelRef(target, { model: "" }, "model");
  setPositiveNumber(target, { limit: "" }, "limit", { min: 1, integer: true });
  setCodexServiceTier(target, { serviceTier: "" });
  expect(target).toEqual({});
});

test("a service tier Codex does not offer is cleared, not stored", () => {
  const target: Record<string, unknown> = { serviceTier: "flex" };
  setCodexServiceTier(target, { serviceTier: "turbo" });
  expect(target).toEqual({});
});

test("a price the catalog cannot read is refused with the forms it reads", () => {
  expect(() => setProviderModels({}, { models: [{ id: "m1", price: { as: "nowhere" } }] }))
    .toThrow('models[].price must be { as: "litellm:<model>" } or { as: "models.dev:<provider>/<model>" } or input and output prices, each a number of USD per 1M tokens, 0 or more');
});

test("a model's cache lifetime is whole minutes from 0 to 1440", () => {
  const saved = (cacheLifetimeMinutes: unknown) => {
    const target: Record<string, unknown> = {};
    setProviderModels(target, { models: [{ id: "m1", cacheLifetimeMinutes }] });
    return (target.models as Array<Record<string, unknown>>)[0];
  };
  expect(saved(45)).toMatchObject({ id: "m1", cacheLifetimeMinutes: 45 });
  expect(saved(0)).toMatchObject({ cacheLifetimeMinutes: 0 });
  expect("cacheLifetimeMinutes" in saved(null)!).toBe(false);
  for (const bad of [-1, 1441, 1.5, "45"]) {
    expect(() => saved(bad)).toThrow("models[].cacheLifetimeMinutes must be whole minutes from 0 to 1440");
  }
});
