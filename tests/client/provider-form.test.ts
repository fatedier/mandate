import { describe, expect, test } from "bun:test";
import {
  buildProvidersPatch,
  makeNewProvider,
  type ModelForm,
  type ProviderCard,
  type ProviderForm,
  providerFormsFromConfig,
  providerStatus,
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
    supportsReasoning: "auto",
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

  test("a new unsaved card is included when it is the save target", () => {
    const a = cleanCard();
    const fresh: ProviderCard = {
      form: makeForm({ originalName: "", name: "provider", type: "openai-compatible" }),
      baseline: null
    };
    const patch = buildProvidersPatch([a, fresh], { savedId: fresh.form.id });
    const providers = patch.models!.providers!;
    expect(Object.keys(providers).sort()).toEqual(["openai", "provider"]);
    expect(providers.provider!.previousName).toBeUndefined();
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

  test("rename sets previousName; unrenamed leaves it undefined", () => {
    const renamed = cleanCard({ originalName: "openai", name: "openai" });
    renamed.form = { ...renamed.form, name: "openai-main" };
    const untouched = cleanCard({ originalName: "anthropic", name: "anthropic", type: "anthropic" });
    const patch = buildProvidersPatch([renamed, untouched], { savedId: renamed.form.id });
    const providers = patch.models!.providers!;
    expect(providers["openai-main"]!.previousName).toBe("openai");
    expect(providers.anthropic!.previousName).toBeUndefined();
  });

  test("saved non-codex card emits the complete payload entry, including clearApiKey passthrough", () => {
    const a = cleanCard({ originalName: "openai", name: "openai" });
    a.form = { ...a.form, apiKey: "sk-new", clearApiKey: true };
    const patch = buildProvidersPatch([a], { savedId: a.form.id });
    const entry = patch.models!.providers!.openai!;
    expect(entry).toEqual({
      previousName: undefined,
      type: "openai",
      baseURL: "https://api.openai.com/v1",
      organizationId: undefined,
      models: [{ id: "gpt-5", input: ["text"] }],
      apiKey: "sk-new",
      clearApiKey: true
    });
    // toEqual treats a missing key and an explicit undefined as equal, so also
    // pin the exact key set: non-codex must emit these seven keys and nothing
    // else (in particular, no serviceTier).
    expect(Object.keys(entry)).toEqual([
      "previousName",
      "type",
      "baseURL",
      "organizationId",
      "models",
      "apiKey",
      "clearApiKey"
    ]);
  });

  test("saving a rename onto another card's baseline name throws, even if that card's form was renamed away", () => {
    const a = cleanCard({ originalName: "openai", name: "openai" });
    a.form = { ...a.form, name: "anthropic" };
    const b = cleanCard({ originalName: "anthropic", name: "anthropic", type: "anthropic" });
    // b's form no longer collides, but b is not the save target so it
    // contributes its baseline name — which the saved rename collides with.
    b.form = { ...b.form, name: "anthropic-renamed" };
    expect(() => buildProvidersPatch([a, b], { savedId: a.form.id })).toThrow(
      "Duplicate provider name: anthropic"
    );
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

  test("duplicate provider names throw", () => {
    const a = cleanCard({ originalName: "openai", name: "openai" });
    const b = cleanCard({ originalName: "anthropic", name: "anthropic", type: "anthropic" });
    b.form = { ...b.form, name: "openai" };
    expect(() => buildProvidersPatch([a, b], { savedId: b.form.id })).toThrow(
      "Duplicate provider name: openai"
    );
  });

  test("invalid provider names throw", () => {
    const a = cleanCard();
    a.form = { ...a.form, name: "bad name!" };
    expect(() => buildProvidersPatch([a], { savedId: a.form.id })).toThrow(
      "Provider names may use letters, numbers, dot, underscore, and hyphen."
    );
  });

  test("returns only { models: { providers } }", () => {
    const patch = buildProvidersPatch([cleanCard()], {});
    expect(Object.keys(patch)).toEqual(["models"]);
    expect(Object.keys(patch.models!)).toEqual(["providers"]);
  });

  test("maps model rows through capability payload (trim, normalized input, reasoning)", () => {
    const a = cleanCard({
      models: [
        makeModel({ modelId: " gpt-5 ", input: ["image"], supportsReasoning: "supported" }),
        makeModel({ modelId: "gpt-4o", input: ["text"], supportsReasoning: "unsupported" }),
        makeModel({ modelId: "o4", input: ["text"], supportsReasoning: "auto" })
      ]
    });
    const patch = buildProvidersPatch([a], { savedId: a.form.id });
    expect(patch.models!.providers!.openai!.models).toEqual([
      { id: "gpt-5", input: ["text", "image"], supportsReasoning: true },
      { id: "gpt-4o", input: ["text"], supportsReasoning: false },
      { id: "o4", input: ["text"] }
    ]);
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
  test("codex with configured auth is signed-in", () => {
    const form = makeForm({
      type: "codex",
      configured: false,
      auth: {
        status: "authenticated",
        configured: true,
        accountId: "acc",
        email: "a@b.c",
        profileId: "p"
      }
    });
    expect(providerStatus(form)).toBe("signed-in");
  });

  test("codex without configured auth is unconfigured", () => {
    expect(providerStatus(makeForm({ type: "codex", configured: true, auth: undefined }))).toBe(
      "unconfigured"
    );
  });

  test("non-codex configured is connected, unconfigured otherwise", () => {
    expect(providerStatus(makeForm({ configured: true }))).toBe("connected");
    expect(providerStatus(makeForm({ configured: false }))).toBe("unconfigured");
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
    expect(codex.models.every((model) => model.supportsReasoning === "supported")).toBe(true);
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
    expect(codex.models[0]).toMatchObject({ modelId: "gpt-5.5", supportsReasoning: "supported" });
    expect(codex.auth?.configured).toBe(true);
    const openai = forms.find((form) => form.name === "openai")!;
    expect(openai.configured).toBe(true);
    expect(openai.organizationId).toBe("");
    expect(openai.serviceTier).toBe("");
    expect(openai.apiKey).toBe("");
    expect(openai.clearApiKey).toBe(false);
    expect(openai.models[0]!.supportsReasoning).toBe("auto");
    expect(openai.models[1]!.supportsReasoning).toBe("unsupported");
    expect(openai.id).not.toBe(codex.id);
    expect(openai.id).toBeTruthy();
  });
});
