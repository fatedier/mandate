import { describe, expect, test } from "bun:test";
import {
  buildProvidersPatch,
  serializeModelForm,
  cacheLifetimeError,
  modelCacheFamily,
  makeNewProvider,
  type ModelForm,
  type ProviderCard,
  type ProviderForm,
  providerFormsFromConfig,
  PROVIDER_STATUS_CHIP,
  providerStatus,
  type ProviderStatus,
  serializeProviderForm
} from "@/routes/settings/provider-form";
import type { SettingsConfigResponse } from "@/routes/settings/types";

let seq = 0;
const nextId = () => `id-${++seq}`;

function makeModel(overrides: Partial<ModelForm> = {}): ModelForm {
  return {
    id: nextId(),
    modelId: "gpt-5",
    input: ["text"],
    supportsReasoning: true,
    protocol: "responses",
    kind: "chat",
    ...overrides
  };
}

function makeForm(overrides: Partial<ProviderForm> = {}): ProviderForm {
  return {
    id: nextId(),
    originalName: "openai",
    name: "openai",
    type: "openai",
    baseURL: "https://api.openai.com/v1",
    organizationId: "",
    serviceTier: "",
    billing: "usage",
    models: [makeModel()],
    apiKey: "",
    clearApiKey: false,
    configured: true,
    auth: undefined,
    ...overrides
  };
}

/** A card whose form and baseline share content (a clean, saved card). */
function cleanCard(overrides: Partial<ProviderForm> = {}): ProviderCard {
  const form = makeForm(overrides);
  return { form, baseline: { ...form, models: form.models.map((m) => ({ ...m })) } };
}

describe("buildProvidersPatch whole-set semantics", () => {
  test("saving card A contributes B's baseline, not B's dirty form", () => {
    const a = cleanCard({ originalName: "openai", name: "openai" });
    a.form = { ...a.form, baseURL: "https://a.example/v1" };
    const b = cleanCard({
      originalName: "anthropic",
      name: "anthropic",
      type: "anthropic",
      baseURL: "https://api.anthropic.com/v1"
    });
    b.form = { ...b.form, baseURL: "https://dirty.example/v1", apiKey: "half-typed" };

    const patch = buildProvidersPatch([a, b], { savedId: a.form.id });
    const providers = patch.models!.providers!;
    expect(Object.keys(providers).sort()).toEqual(["anthropic", "openai"]);
    expect(providers.openai!.baseURL).toBe("https://a.example/v1");
    expect(providers.anthropic!.baseURL).toBe("https://api.anthropic.com/v1");
    expect(providers.anthropic!.apiKey).toBe("");
  });

  test("a new unsaved card (baseline null) is excluded when saving another card", () => {
    const a = cleanCard();
    const fresh: ProviderCard = {
      form: makeForm({ originalName: "", name: "provider", type: "openai-compatible" }),
      baseline: null
    };
    const patch = buildProvidersPatch([a, fresh], { savedId: a.form.id });
    expect(Object.keys(patch.models!.providers!)).toEqual(["openai"]);
  });

  test("deletedId card is absent while every other provider stays present", () => {
    const a = cleanCard({ originalName: "openai", name: "openai" });
    const b = cleanCard({ originalName: "anthropic", name: "anthropic", type: "anthropic" });
    const c = cleanCard({ originalName: "google", name: "google", type: "google" });
    const patch = buildProvidersPatch([a, b, c], { deletedId: b.form.id });
    const providers = patch.models!.providers!;
    expect(Object.keys(providers)).toHaveLength(2);
    expect(Object.keys(providers).sort()).toEqual(["google", "openai"]);
  });

  // A name is fixed once saved: a saved card is sent under the name it was
  // saved with, whatever its form says; only a new card's typed name counts.
  test("a saved provider is sent under the name it was saved with", () => {
    const saved = cleanCard({ originalName: "openai", name: "openai" });
    saved.form = { ...saved.form, name: "openai-main" };
    const patch = buildProvidersPatch([saved], { savedId: saved.form.id });
    expect(Object.keys(patch.models!.providers!)).toEqual(["openai"]);
  });

  test("saved non-codex card emits the complete payload entry, including clearApiKey passthrough", () => {
    const a = cleanCard({ originalName: "openai", name: "openai" });
    a.form = { ...a.form, apiKey: "sk-new", clearApiKey: true };
    const patch = buildProvidersPatch([a], { savedId: a.form.id });
    const entry = patch.models!.providers!.openai!;
    expect(entry).toEqual({
      type: "openai",
      baseURL: "https://api.openai.com/v1",
      organizationId: undefined,
      billing: "usage",
      models: [{ id: "gpt-5", input: ["text"], supportsReasoning: true }],
      apiKey: "sk-new",
      clearApiKey: true
    });
    // toEqual treats a missing key and an explicit undefined as equal, so also
    // pin the exact key set: non-codex must emit these seven keys and nothing
    // else (in particular, no serviceTier).
    expect(Object.keys(entry)).toEqual([
      "type",
      "baseURL",
      "organizationId",
      "billing",
      "models",
      "apiKey",
      "clearApiKey"
    ]);
  });

  test("deleting the last provider yields exactly an empty providers record", () => {
    const only = cleanCard();
    const patch = buildProvidersPatch([only], { deletedId: only.form.id });
    expect(patch).toEqual({ models: { providers: {} } });
    expect(Object.keys(patch.models!.providers!)).toEqual([]);
  });

  test("codex contributes serviceTier and no organizationId; kilo contributes organizationId", () => {
    const codex = cleanCard({
      originalName: "codex",
      name: "codex",
      type: "codex",
      baseURL: "",
      serviceTier: "priority",
      organizationId: "should-not-leak"
    });
    const kilo = cleanCard({
      originalName: "kilo",
      name: "kilo",
      type: "kilo",
      organizationId: "org-42"
    });
    const patch = buildProvidersPatch([codex, kilo], { savedId: codex.form.id });
    const providers = patch.models!.providers!;
    expect(providers.codex!.serviceTier).toBe("priority");
    expect(providers.codex!.organizationId).toBeUndefined();
    expect(providers.kilo!.organizationId).toBe("org-42");
    expect(providers.kilo!.serviceTier).toBeUndefined();
  });

  test("a new provider named like a saved one throws", () => {
    const a = cleanCard({ originalName: "openai", name: "openai" });
    const b: ProviderCard = { form: makeForm({ originalName: "", name: "openai", type: "openai-compatible" }), baseline: null };
    expect(() => buildProvidersPatch([a, b], { savedId: b.form.id })).toThrow(
      "Duplicate provider name: openai"
    );
  });

  test("maps model rows through capability payload (trim, normalized input, reasoning)", () => {
    const a = cleanCard({
      models: [
        makeModel({ modelId: " gpt-5 ", input: ["image"], supportsReasoning: true }),
        makeModel({ modelId: "gpt-4o", input: ["text"], supportsReasoning: false }),
        makeModel({ modelId: "o4", input: ["text"] })
      ]
    });
    const patch = buildProvidersPatch([a], { savedId: a.form.id });
    expect(patch.models!.providers!.openai!.models).toEqual([
      { id: "gpt-5", input: ["text", "image"], supportsReasoning: true },
      { id: "gpt-4o", input: ["text"], supportsReasoning: false },
      { id: "o4", input: ["text"], supportsReasoning: true }
    ]);
  });
});

describe("model protocol round trip", () => {
  test("a custom provider's model keeps its protocol through the form into the patch; responses and other types send none", () => {
    const config = {
      models: {
        providers: {
          proxy: {
            type: "openai-compatible",
            baseURL: "http://127.0.0.1:9/v1",
            models: [
              { id: "model-a", input: ["text"], protocol: "messages" },
              { id: "model-b", input: ["text"], protocol: "chat" },
              { id: "model-c", input: ["text"] }
            ],
            apiKeyConfigured: true
          },
          direct: {
            type: "openai",
            baseURL: "https://api.openai.com/v1",
            models: [{ id: "model-d", input: ["text"] }],
            apiKeyConfigured: true
          }
        }
      }
    } as unknown as SettingsConfigResponse;
    const cards = providerFormsFromConfig(config).map((form) => ({ form, baseline: { ...form } }));
    const direct = cards.find((card) => card.form.name === "direct")!;
    // A protocol on a type that has one API is never sent, even if a form held one.
    direct.form = { ...direct.form, models: direct.form.models.map((model) => ({ ...model, protocol: "chat" as const })) };
    const patch = buildProvidersPatch(cards, { savedId: direct.form.id });
    expect(patch.models!.providers!.proxy!.models!.map((m) => [m.id, m.protocol ?? null])).toEqual([
      ["model-a", "messages"],
      ["model-b", "chat"],
      ["model-c", null]
    ]);
    expect(patch.models!.providers!.direct!.models![0]!.protocol).toBeUndefined();
  });
});

describe("model kind round trip", () => {
  test("a custom provider's decision model stays one when another provider is saved; other types send none", () => {
    const config = {
      models: {
        providers: {
          proxy: {
            type: "openai-compatible",
            baseURL: "http://127.0.0.1:9/v1",
            models: [{ id: "vendor/judge-1", input: ["text"], kind: "decision" }, { id: "model-c", input: ["text"] }],
            apiKeyConfigured: true
          },
          direct: { type: "openai", baseURL: "https://api.openai.com/v1", models: [{ id: "model-d", input: ["text"] }], apiKeyConfigured: true }
        }
      }
    } as unknown as SettingsConfigResponse;
    const cards = providerFormsFromConfig(config).map((form) => ({ form, baseline: { ...form } }));
    const direct = cards.find((card) => card.form.name === "direct")!;
    // A kind on a type that cannot serve one is never sent, even if a form held one.
    direct.form = { ...direct.form, baseURL: "https://other.example/v1", models: direct.form.models.map((model) => ({ ...model, kind: "decision" as const })) };
    const patch = buildProvidersPatch(cards, { savedId: direct.form.id });
    expect(patch.models!.providers!.proxy!.models!.map((m) => [m.id, m.kind ?? null])).toEqual([
      ["vendor/judge-1", "decision"],
      ["model-c", null]
    ]);
    expect(patch.models!.providers!.direct!.models![0]!.kind).toBeUndefined();
  });
});

describe("serializeProviderForm", () => {
  test("equal for same content with different volatile ids", () => {
    const a = makeForm({ models: [makeModel()] });
    const b = { ...a, id: nextId(), models: a.models.map((m) => ({ ...m, id: nextId() })) };
    expect(serializeProviderForm(a)).toBe(serializeProviderForm(b));
  });

  test("unequal when a model row changes", () => {
    const a = makeForm({ models: [makeModel({ modelId: "gpt-5" })] });
    const b = { ...a, models: [{ ...a.models[0]!, modelId: "gpt-5.5" }] };
    expect(serializeProviderForm(a)).not.toBe(serializeProviderForm(b));
  });
});

describe("providerStatus", () => {
  const signedIn = { status: "authenticated" as const, configured: true, accountId: "a", email: "e", profileId: "p" };
  const at = "2026-01-01T00:00:00.000Z";

  // A saved key is not a working one: only a check says Ready or Check failed.
  test("each state, in order: unsaved, Codex sign-in, no key, a check's answer, a saved key", () => {
    const rows: Array<[string, ProviderStatus]> = [
      ["unsaved", providerStatus({ form: makeForm({ configured: true }), baseline: null }, undefined)],
      ["codex signed in", providerStatus(cleanCard({ type: "codex", auth: signedIn }), undefined)],
      ["codex expired", providerStatus(cleanCard({ type: "codex", auth: { ...signedIn, status: "expired" } }), undefined)],
      ["codex signed out", providerStatus(cleanCard({ type: "codex", configured: true, auth: undefined }), undefined)],
      ["no key", providerStatus(cleanCard({ configured: false }), { phase: "done", check: { result: "ready", modelCount: 1, checkedAt: at }, connection: "" })],
      ["checking", providerStatus(cleanCard(), { phase: "checking", connection: "" })],
      ["ready", providerStatus(cleanCard(), { phase: "done", check: { result: "ready", modelCount: 3, checkedAt: at }, connection: "" })],
      ["failed", providerStatus(cleanCard(), { phase: "done", check: { result: "failed", message: "401 Unauthorized", checkedAt: at }, connection: "" })],
      ["key saved", providerStatus(cleanCard(), undefined)],
      ["key saved, unchecked", providerStatus(cleanCard(), { phase: "done", check: { result: "unchecked", reason: "no-key" }, connection: "" })]
    ];
    expect(rows).toEqual([
      ["unsaved", "not-saved"],
      ["codex signed in", "signed-in"],
      ["codex expired", "expired"],
      ["codex signed out", "signed-out"],
      ["no key", "no-key"],
      ["checking", "checking"],
      ["ready", "ready"],
      ["failed", "failed"],
      ["key saved", "key-saved"],
      ["key saved, unchecked", "key-saved"]
    ]);
  });

  test("each state has its words and tone", () => {
    expect(Object.entries(PROVIDER_STATUS_CHIP).map(([status, chip]) => [status, chip.label, chip.tone])).toEqual([
      ["not-saved", "Not saved", "idle"],
      ["signed-in", "Signed in", "ready"],
      ["expired", "Sign-in expired", "attention"],
      ["signed-out", "Not signed in", "idle"],
      ["no-key", "No key", "idle"],
      ["checking", "Checking…", "idle"],
      ["ready", "Ready", "ready"],
      ["failed", "Check failed", "failed"],
      ["key-saved", "Key saved", "idle"]
    ]);
  });
});

describe("makeNewProvider", () => {
  test("Codex starts with the GPT-5.6 family and keeps GPT-5.5 available", () => {
    const codex = makeNewProvider([], "codex");
    expect(codex.models.map((model) => model.modelId)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5"
    ]);
    expect(codex.models.every((model) => model.supportsReasoning === true)).toBe(true);
    expect(codex.models.every((model) => model.input.includes("image"))).toBe(true);
  });

  test("duplicate template names number from 2: openai, openai-2, openai-3", () => {
    const first = makeNewProvider([], "openai");
    expect(first.name).toBe("openai");
    const second = makeNewProvider([first], "openai");
    expect(second.name).toBe("openai-2");
    const third = makeNewProvider([first, second], "openai");
    expect(third.name).toBe("openai-3");
  });

  test("numbering skips taken suffixes and ignores unrelated names", () => {
    const openai2 = makeForm({ name: "openai-2" });
    const anthropic = makeForm({ name: "anthropic", type: "anthropic" });
    expect(makeNewProvider([openai2, anthropic], "openai").name).toBe("openai");
    const openai = makeForm({ name: "openai" });
    expect(makeNewProvider([openai, openai2, anthropic], "openai").name).toBe("openai-3");
  });
});

describe("providerFormsFromConfig", () => {
  test("maps providers into forms with fresh ids and normalized fields", () => {
    const config = {
      models: {
        providers: {
          codex: {
            type: "codex",
            baseURL: "",
            serviceTier: "flex",
            models: [{ id: "gpt-5.5", input: ["text"], supportsReasoning: true }],
            apiKeyConfigured: false,
            auth: {
              status: "authenticated",
              configured: true,
              accountId: "acc",
              email: "a@b.c",
              profileId: "p"
            }
          },
          openai: {
            type: "openai",
            baseURL: "https://api.openai.com/v1",
            models: [
              { id: "gpt-5", input: ["text", "image"] },
              { id: "gpt-4o", input: ["text"], supportsReasoning: false }
            ],
            apiKeyConfigured: true
          }
        }
      }
    } as unknown as SettingsConfigResponse;

    const forms = providerFormsFromConfig(config);
    expect(forms).toHaveLength(2);
    const codex = forms.find((form) => form.name === "codex")!;
    expect(codex.originalName).toBe("codex");
    expect(codex.serviceTier).toBe("flex");
    expect(codex.models[0]).toMatchObject({ modelId: "gpt-5.5", supportsReasoning: true });
    expect(codex.auth?.configured).toBe(true);
    const openai = forms.find((form) => form.name === "openai")!;
    expect(openai.configured).toBe(true);
    expect(openai.organizationId).toBe("");
    expect(openai.serviceTier).toBe("");
    expect(openai.apiKey).toBe("");
    expect(openai.clearApiKey).toBe(false);
    expect(openai.models[0]!.supportsReasoning).toBe(true);
    expect(openai.models[1]!.supportsReasoning).toBe(false);
    expect(openai.id).not.toBe(codex.id);
    expect(openai.id).toBeTruthy();
  });
});

describe("model price round trip", () => {
  test("a model's price stays with it when another provider or model is saved", () => {
    const config = {
      models: {
        providers: {
          gw: {
            type: "openai-compatible",
            baseURL: "https://gw.example.test/v1",
            billing: "usage",
            models: [
              { id: "openai/gpt-6.1-sol", input: ["text"], price: { as: "litellm:gpt-6.1-sol" } },
              { id: "local-model", input: ["text"], price: { input: 3, output: 15 } },
              { id: "plain", input: ["text"] }
            ],
            apiKeyConfigured: true
          }
        }
      }
    } as unknown as SettingsConfigResponse;
    const cards = providerFormsFromConfig(config).map((form) => ({ form, baseline: { ...form } }));
    const gw = cards[0]!;
    gw.form = { ...gw.form, models: gw.form.models.map((m) => (m.modelId === "plain" ? { ...m, supportsReasoning: false } : m)) };
    const patch = buildProvidersPatch(cards, { savedId: gw.form.id });
    expect(patch.models!.providers!.gw!.models!.map((m) => [m.id, m.price ?? null])).toEqual([
      ["openai/gpt-6.1-sol", { as: "litellm:gpt-6.1-sol" }],
      ["local-model", { input: 3, output: 15 }],
      ["plain", null]
    ]);
  });
});

describe("model cache lifetime round trip", () => {
  test("a typed lifetime stays with its model; empty means the default and is not sent", () => {
    const config = {
      models: { providers: { gw: {
        type: "openai-compatible", baseURL: "https://gw.example.test/v1", billing: "usage", apiKeyConfigured: true,
        models: [{ id: "openai/gpt-6.1-sol", input: ["text"], cacheLifetimeMinutes: 45 }, { id: "zero", input: ["text"], cacheLifetimeMinutes: 0 }, { id: "plain", input: ["text"] }, { id: "off", input: ["text"], cacheLifetimeMinutes: 0 }]
      } } }
    } as unknown as SettingsConfigResponse;
    const cards = providerFormsFromConfig(config).map((form) => ({ form, baseline: { ...form } }));
    const gw = cards[0]!;
    expect(gw.form.models.map((m) => m.cacheLifetimeMinutes ?? "")).toEqual(["45", "0", "", "0"]);
    gw.form = { ...gw.form, models: gw.form.models.map((m) => (m.modelId === "plain" ? { ...m, cacheLifetimeMinutes: " 20 " } : m.modelId === "zero" ? { ...m, cacheLifetimeMinutes: "  " } : m)) };
    const patch = buildProvidersPatch(cards, { savedId: gw.form.id });
    expect(patch.models!.providers!.gw!.models!.map((m) => [m.id, m.cacheLifetimeMinutes ?? null])).toEqual([
      ["openai/gpt-6.1-sol", 45], ["zero", null], ["plain", 20], ["off", 0]
    ]);
  });

  // A lifetime typed before the model became a decision model is hidden, so it is not sent either.
  test("a decision model sends no cache lifetime", () => {
    const config = {
      models: { providers: { gw: {
        type: "openai-compatible", baseURL: "https://gw.example.test/v1", billing: "usage", apiKeyConfigured: true,
        models: [{ id: "openrouter/decide", input: ["text"] }]
      } } }
    } as unknown as SettingsConfigResponse;
    const cards = providerFormsFromConfig(config).map((form) => ({ form, baseline: { ...form } }));
    const gw = cards[0]!;
    gw.form = { ...gw.form, models: gw.form.models.map((m) => ({ ...m, kind: "decision" as const, cacheLifetimeMinutes: "-1" })) };
    const patch = buildProvidersPatch(cards, { savedId: gw.form.id });
    expect(patch.models!.providers!.gw!.models![0]).not.toHaveProperty("cacheLifetimeMinutes");
  });

  test("a model's draft compares the same whatever order its settings were set in", () => {
    const base = { id: "row-1", modelId: "openai/gpt-6.1-sol", input: ["text" as const], supportsReasoning: true, protocol: "responses" as const, kind: "chat" as const };
    const price = { mode: "custom", input: 3, output: 15 } as unknown as NonNullable<Parameters<typeof serializeModelForm>[0]["price"]>;
    expect(serializeModelForm({ ...base, price, cacheLifetimeMinutes: "45" })).toBe(serializeModelForm({ ...base, cacheLifetimeMinutes: "45", price }));
  });

  test("a model's family: Claude by its API, GPT by OpenAI's ids, any other off", () => {
    expect([
      modelCacheFamily("anthropic", "responses", "claude-sonnet-5-5"),
      modelCacheFamily("openai-compatible", "messages", "anthropic/claude-sonnet-5-5"),
      modelCacheFamily("kilo", "responses", "anthropic/claude-sonnet-5.5"),
      modelCacheFamily("openai", "responses", "gpt-5.5"),
      modelCacheFamily("openai-compatible", "responses", "openai/gpt-6.1-sol"),
      modelCacheFamily("openai-compatible", "responses", "deepseek/deepseek-v4-flash"),
      // As the server: a ChatGPT sign-in's models and Google's are off by default.
      modelCacheFamily("codex", "responses", "gpt-5.6-sol"),
      modelCacheFamily("google", "responses", "gemini-3.5-pro"),
      modelCacheFamily("kilo", "responses", "openai/gpt-6.1-sol"),
      modelCacheFamily("kilo", "responses", "deepseek/deepseek-v4-flash")
    ]).toEqual(["claude", "claude", "claude", "gpt", "gpt", "other", "other", "other", "gpt", "other"]);
  });

  test("a lifetime is whole minutes, 0 or more, and at most 60 for Claude", () => {
    expect([cacheLifetimeError("", "claude"), cacheLifetimeError("0", "gpt"), cacheLifetimeError("60", "claude"), cacheLifetimeError(" 45 ", "other")]).toEqual(["", "", "", ""]);
    expect(["-1", "x", "1.5"].map((raw) => cacheLifetimeError(raw, "gpt"))).toEqual(Array(3).fill("Enter whole minutes, 0 or more."));
    expect(cacheLifetimeError("61", "claude")).toBe("At most 60 for a Claude model.");
    expect(cacheLifetimeError("61", "gpt")).toBe("");
  });
});
