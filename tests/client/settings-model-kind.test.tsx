import { expect, test } from "bun:test";
import { act, useState } from "react";
import { EditModelDialog } from "@/routes/settings/EditModelDialog";
import { ProviderModels } from "@/routes/settings/ProviderModels";
import type { ModelForm } from "@/routes/settings/provider-form";
import { modelRoutingUses, routingUseLabel } from "@/routes/settings/provider-display";
import { modelMenuGroups, modelRefOptions } from "@/routes/settings/routing-form";
import type { ProviderType, SettingsConfigResponse } from "@/routes/settings/types";
import { mount } from "../helpers/mount.js";

// A model's kind: a custom provider's model is a chat model or a decision
// model. A decision model hides what only chatting uses, carries a tag, and
// is offered only where decisions are made; a model an agent route uses
// cannot become one.

const HELP = "Answers typed questions through OpenRouter's Decisions API instead of chatting. Only Decisions can use it.";
const CHAT: ModelForm = { id: "row-1", modelId: "vendor/judge-1", input: ["text", "image"], supportsReasoning: true, protocol: "responses", kind: "chat" };

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const group = (label: string) => dialog().querySelector<HTMLElement>(`[aria-label="${label}"]:not([role="radio"])`);
const kindRadios = () => Array.from(group("Kind")?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []);
const kindRadio = (name: string) => kindRadios().find((el) => el.textContent?.includes(name))!;
const has = (text: string) => dialog().textContent?.includes(text) ?? false;
const hasSwitch = (label: string) => dialog().querySelector(`[role="switch"][aria-label="${label}"]`) !== null;
const button = (text: string) => Array.from(dialog().querySelectorAll("button")).find((el) => el.textContent?.trim() === text)!;
const click = (el: HTMLElement) => act(() => el.click());
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

// ---- the edit dialog ----

let saved: ModelForm[] = [];
function renderDialog(providerType: ProviderType, model: ModelForm = CHAT, kindBlocked: string | null = null) {
  saved = [];
  mount(
    <EditModelDialog
      open
      model={model}
      providerType={providerType}
      providerName="gw"
      declared={undefined}
      locked={false}
      kindBlocked={kindBlocked}
      onCancel={() => {}}
      onSave={async (next) => { saved.push(next); }}
    />
  );
}

test("a custom provider's model has a kind, Chat model or Decision model; one never marked is a chat model", () => {
  renderDialog("openai-compatible");
  expect(kindRadios().map((el) => [el.textContent, el.getAttribute("aria-checked")])).toEqual([["Chat model", "true"], ["Decision model", "false"]]);
  expect([has(HELP), hasSwitch("Image input"), hasSwitch("Reasoning"), group("Protocol") !== null]).toEqual([false, true, true, true]);
});

test("a decision model hides image input, reasoning and protocol, says what it is, and saves its kind", () => {
  renderDialog("openai-compatible");
  click(kindRadio("Decision model"));
  expect([has(HELP), hasSwitch("Image input"), hasSwitch("Reasoning"), group("Protocol") !== null, has("Capabilities")]).toEqual([true, false, false, false, false]);
  click(button("Save"));
  expect(saved.map((model) => model.kind)).toStrictEqual(["decision"]);
});

test("another provider type has no kind to choose", () => {
  renderDialog("openai");
  expect([group("Kind") !== null, has("Decision model"), hasSwitch("Reasoning")]).toEqual([false, false, true]);
});

test("a decision model can always go back to being a chat model", () => {
  renderDialog("openai-compatible", { ...CHAT, kind: "decision" }, "In use by Routing (default model). Change that first.");
  expect([kindRadio("Chat model").disabled, has("In use by")]).toEqual([false, false]);
  click(kindRadio("Chat model"));
  expect([has(HELP), hasSwitch("Reasoning")]).toEqual([false, true]);
});

// ---- the models list ----

const config = {
  models: {
    default: { model: "gw/chat-a", reasoningEffort: "provider-default", modelFallbacks: [] },
    providers: {
      gw: { type: "openai-compatible", models: [{ id: "chat-a", input: ["text"] }, { id: "jev", input: ["text"], kind: "decision" }, { id: "chat-b", input: ["text"] }] }
    }
  },
  agent: {
    modelOverrides: { manager: false, worker: false, global: false, dream: false, extraction: false, subagent: false, page: false, managerRequestCheck: true, managerStopCheck: false, memoryRepeatCheck: false },
    managerRequestCheckEnabled: true,
    managerStopCheckEnabled: false,
    managerStopCheckModel: { model: "", reasoningEffort: "provider-default" },
    managerStopCheckModelFallbacks: [],
    memoryRepeatCheckEnabled: false,
    memoryRepeatCheckModel: { model: "", reasoningEffort: "provider-default" },
    memoryRepeatCheckModelFallbacks: [],
    decisionsEnabled: true,
    decisionsModel: { model: "gw/jev", reasoningEffort: "provider-default" },
    decisionsModelFallbacks: [{ model: "gw/chat-b", reasoningEffort: "provider-default" }],
    managerRequestCheckModel: { model: "gw/chat-b", reasoningEffort: "provider-default" },
    managerRequestCheckModelFallbacks: []
  },
  memory: { embedding: { model: "" } }
} as unknown as SettingsConfigResponse;

const MODELS: ModelForm[] = [
  { id: "r1", modelId: "chat-a", input: ["text"], supportsReasoning: false, protocol: "responses", kind: "chat" },
  // Image input, reasoning and a protocol left from before it was marked: none of them shows.
  { id: "r2", modelId: "jev", input: ["text", "image"], supportsReasoning: true, protocol: "chat", kind: "decision" },
  { id: "r3", modelId: "chat-b", input: ["text"], supportsReasoning: false, protocol: "responses", kind: "chat" }
];

function Harness() {
  const [models, setModels] = useState(MODELS);
  return (
    <ProviderModels
      providerKey="gw"
      providerType="openai-compatible"
      models={models}
      config={config}
      catalog={{ models: [], source: "configured" }}
      locked={false}
      onRefreshCatalog={() => {}}
      onSaveModels={async (next) => { setModels(next); }}
    />
  );
}

const row = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-model-row="${id}"]`)!;
async function edit(host: HTMLElement, id: string) {
  act(() => row(host, id).querySelector<HTMLButtonElement>("button")!.click());
  await flush();
}

test("a decision model's row carries the Decision model tag and its uses, and no image, reasoning or protocol", () => {
  const { host } = mount(<Harness />);
  const jev = row(host, "jev");
  expect(jev.textContent).toContain("Decision model");
  expect(jev.textContent).toContain("Decisions");
  expect([jev.querySelector('[aria-label="Image input"]') !== null, jev.querySelector('[aria-label="Reasoning"]') !== null, jev.textContent?.includes("Chat Completions")]).toEqual([false, false, false]);
  expect(row(host, "chat-b").textContent).toContain("Manager request check");
  expect(row(host, "chat-a").textContent?.includes("Decision model")).toBe(false);
});

test("the default model cannot become a decision model; one that only Decisions and manager request check use can", async () => {
  const { host } = mount(<Harness />);
  await edit(host, "chat-a");
  expect([kindRadio("Decision model").disabled, has("In use by Routing (default model). Change that first.")]).toEqual([true, true]);
  click(button("Cancel"));
  await flush();
  await edit(host, "chat-b");
  expect([kindRadio("Decision model").disabled, has("In use by")]).toEqual([false, false]);
});

// ---- where a decision model is offered ----

test("agent route menus and the embeddings list leave decision models out; Decisions' menus list them", () => {
  const refs = (groups: ReturnType<typeof modelMenuGroups>) => groups.flatMap((g) => g.models.map((m) => m.ref));
  expect(refs(modelMenuGroups(config, new Set()))).toEqual(["gw/chat-a", "gw/chat-b"]);
  expect(refs(modelMenuGroups(config, new Set(), undefined, { decisions: true }))).toEqual(["gw/chat-a", "gw/jev", "gw/chat-b"]);
  expect(modelRefOptions(config).map((o) => o.value)).toEqual(["gw/chat-a", "gw/chat-b"]);
  // One already chosen is still offered, first, as a ref no provider serves is.
  expect(modelRefOptions(config, "gw/jev").map((o) => o.value)).toEqual(["gw/jev", "gw/chat-a", "gw/chat-b"]);
});

test("Decisions while on, and manager request check's own route while on, count as uses", () => {
  expect(modelRoutingUses(config, "gw/jev")).toEqual(["decisions"]);
  expect(modelRoutingUses(config, "gw/chat-b")).toEqual(["fallback", "managerRequestCheck"]);
  const off = { ...config, agent: { ...config.agent, decisionsEnabled: false, modelOverrides: { ...config.agent.modelOverrides, managerRequestCheck: false } } } as SettingsConfigResponse;
  expect([modelRoutingUses(off, "gw/jev"), modelRoutingUses(off, "gw/chat-b")]).toEqual([[], []]);
  expect([routingUseLabel("decisions", "tag"), routingUseLabel("decisions", "subline")]).toEqual(["Decisions", "decisions"]);
});

// A use of Decisions counts while its On is on and its own route is set.
test("manager request check and manager stop check count as uses only while each is on", () => {
  const withAgent = (agent: Record<string, unknown>) => ({ ...config, agent: { ...config.agent, ...agent } }) as SettingsConfigResponse;
  const stopOwn = { modelOverrides: { ...config.agent.modelOverrides, managerStopCheck: true }, managerStopCheckModel: { model: "gw/chat-a", reasoningEffort: "provider-default" } };
  expect(modelRoutingUses(withAgent({ ...stopOwn, managerStopCheckEnabled: true }), "gw/chat-a")).toEqual(["default", "managerStopCheck"]);
  expect(modelRoutingUses(withAgent(stopOwn), "gw/chat-a")).toEqual(["default"]);
  expect(modelRoutingUses(withAgent({ managerRequestCheckEnabled: false }), "gw/chat-b")).toEqual(["fallback"]);
  expect([routingUseLabel("managerStopCheck", "tag"), routingUseLabel("managerStopCheck", "subline")]).toEqual(["Manager stop check", "manager stop check"]);
  const repeatOwn = { modelOverrides: { ...config.agent.modelOverrides, memoryRepeatCheck: true }, memoryRepeatCheckModel: { model: "gw/chat-a", reasoningEffort: "provider-default" } };
  expect(modelRoutingUses(withAgent({ ...repeatOwn, memoryRepeatCheckEnabled: true }), "gw/chat-a")).toEqual(["default", "memoryRepeatCheck"]);
  expect(modelRoutingUses(withAgent(repeatOwn), "gw/chat-a")).toEqual(["default"]);
  expect([routingUseLabel("memoryRepeatCheck", "tag"), routingUseLabel("memoryRepeatCheck", "subline")]).toEqual(["Memory repeat check", "memory repeat check"]);
});
