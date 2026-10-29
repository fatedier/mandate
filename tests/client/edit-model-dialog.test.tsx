import { expect, test } from "bun:test";
import { act } from "react";
import { EditModelDialog } from "@/routes/settings/EditModelDialog";
import type { ModelForm } from "@/routes/settings/provider-form";
import type { ProviderType } from "@/routes/settings/types";
import { mount } from "../helpers/mount.js";

// Editing one model: its protocol (a custom provider's only), its image
// input and reasoning, each said in a line; Save hands the draft over to be
// saved, Cancel hands nothing, and Save is off while nothing has changed.

const MODEL: ModelForm = { id: "row-1", modelId: "anthropic/claude-opus-5-5", input: ["text", "image"], supportsReasoning: true, protocol: "responses", kind: "chat" };

let saved: ModelForm[] = [];
let cancelled = 0;

function render(providerType: ProviderType, model: ModelForm = MODEL, declared?: { image?: boolean; reasoning?: boolean }) {
  saved = [];
  cancelled = 0;
  mount(
    <EditModelDialog
      open
      model={model}
      providerType={providerType}
      providerName="proxy"
      declared={declared}
      locked={false}
      onCancel={() => { cancelled += 1; }}
      onSave={async (next) => { saved.push(next); }}
    />
  );
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
// The protocol's options; a custom provider's model also has a kind to choose (settings-model-kind).
const radios = () => Array.from(dialog().querySelectorAll<HTMLButtonElement>('[aria-label="Protocol"] [role="radio"]'));
const radio = (name: string) => radios().find((el) => el.textContent?.includes(name))!;
const switchFor = (label: string) => dialog().querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!;
const button = (text: string) => Array.from(dialog().querySelectorAll("button")).find((el) => el.textContent?.trim() === text)!;
const click = (el: HTMLElement) => act(() => el.click());

test("the title names the model; a custom provider offers the three protocols, Responses when none was chosen", () => {
  render("openai-compatible");
  expect(dialog().textContent).toContain("anthropic/claude-opus-5-5");
  expect(radios().map((el) => [el.textContent, el.getAttribute("aria-checked")])).toEqual([
    ["ResponsesOpenAI's current API", "true"],
    ["Chat CompletionsOpenAI's classic API", "false"],
    ["MessagesAnthropic's API", "false"]
  ]);
});

test("another provider type has one API: no protocol to choose", () => {
  render("openai");
  expect(radios().length).toBe(0);
  expect(dialog().textContent).not.toContain("Protocol");
});

test("choosing Messages and pressing Save hands it over", () => {
  render("openai-compatible");
  click(radio("Messages"));
  click(button("Save"));
  expect(saved).toStrictEqual([{ ...MODEL, protocol: "messages" }]);
  expect(cancelled).toBe(0);
});

test("pressing the chosen protocol again keeps it chosen", () => {
  render("openai-compatible");
  click(radio("Responses"));
  expect(radio("Responses").getAttribute("aria-checked")).toBe("true");
});

test("the capabilities are switches, each with what it does; Save hands them over", () => {
  render("openai-compatible");
  expect(dialog().textContent).toContain("Reads images you attach and screenshots its tools return.");
  expect(dialog().textContent).toContain("Thinks before it answers, at the effort Routing sets.");
  click(switchFor("Image input"));
  click(switchFor("Reasoning"));
  click(button("Save"));
  expect(saved).toStrictEqual([{ ...MODEL, input: ["text"], supportsReasoning: false }]);
});

test("Cancel writes nothing", () => {
  render("openai-compatible");
  click(radio("Chat Completions"));
  click(button("Cancel"));
  expect([saved, cancelled]).toEqual([[], 1]);
});

test("Save is off while nothing has changed, and again once a change is undone", () => {
  render("openai-compatible");
  expect(button("Save").disabled).toBe(true);
  click(radio("Messages"));
  expect(button("Save").disabled).toBe(false);
  click(radio("Responses"));
  expect(button("Save").disabled).toBe(true);
  click(button("Save"));
  expect([saved, cancelled]).toEqual([[], 0]);
});

test("values from the provider's list say so; changed by hand, a button puts them back", () => {
  render("openai-compatible", { ...MODEL, input: ["text"] }, { image: false });
  expect(dialog().querySelector("[data-cap-note]")?.textContent).toBe("From proxy's model list");
  click(switchFor("Image input"));
  const reset = dialog().querySelector<HTMLButtonElement>("button[data-cap-reset]")!;
  expect(reset.textContent).toBe("Use proxy's values");
  click(reset);
  expect(switchFor("Image input").getAttribute("aria-checked")).toBe("false");
  expect(dialog().querySelector("[data-cap-note]")).not.toBeNull();
});

test("a capability the list doesn't mention goes back to on", () => {
  render("anthropic", { ...MODEL, input: ["text"], supportsReasoning: false }, { image: false });
  click(dialog().querySelector<HTMLButtonElement>("button[data-cap-reset]")!);
  expect([switchFor("Image input").getAttribute("aria-checked"), switchFor("Reasoning").getAttribute("aria-checked")]).toEqual(["false", "true"]);
});

test("a list that declares reasoning off puts reasoning back off", () => {
  render("anthropic", MODEL, { image: true, reasoning: false });
  click(dialog().querySelector<HTMLButtonElement>("button[data-cap-reset]")!);
  expect([switchFor("Image input").getAttribute("aria-checked"), switchFor("Reasoning").getAttribute("aria-checked")]).toEqual(["true", "false"]);
});

test("a model whose list declares nothing shows neither the line nor the button", () => {
  render("anthropic", MODEL, undefined);
  click(switchFor("Reasoning"));
  expect([dialog().querySelector("[data-cap-note]") === null, dialog().querySelector("[data-cap-reset]") === null]).toEqual([true, true]);
});

// Idle compaction: each model's cache lifetime, typed; empty, its family's.
const lifetimeInput = () => dialog().querySelector<HTMLInputElement>('input[aria-label="Cache lifetime"]');
const typeInto = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
  input.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
});

test("a Claude model's cache lifetime: 60 by default, and it says it is at most 60", () => {
  render("anthropic", { ...MODEL, modelId: "claude-sonnet-5-5" });
  expect(dialog().textContent).toContain("Prompt cache");
  expect(dialog().textContent).toContain("How long the provider keeps this model's cached prompt after its last use. Idle threads are compacted shortly before it ends. Empty uses the default; 0 turns it off for this model. At most 60: Mandate asks Claude for a one-hour cache.");
  expect(lifetimeInput()!.placeholder).toBe("60");
});

test("a GPT model's default is 30, with no Claude limit said", () => {
  render("openai-compatible", { ...MODEL, modelId: "openai/gpt-6.1-sol" });
  expect(lifetimeInput()!.placeholder).toBe("30");
  expect(dialog().textContent).not.toContain("At most 60");
});

test("any other model's default is off", () => {
  render("openai-compatible", { ...MODEL, modelId: "deepseek/deepseek-v4-flash" });
  expect(lifetimeInput()!.placeholder).toBe("Off");
});

test("a typed lifetime is handed over", () => {
  render("openai-compatible", { ...MODEL, modelId: "openai/gpt-6.1-sol" });
  typeInto(lifetimeInput()!, "45");
  click(button("Save"));
  expect(saved[0]!.cacheLifetimeMinutes).toBe("45");
});

test("a lifetime out of range is refused and Save stays off", () => {
  render("anthropic", { ...MODEL, modelId: "claude-sonnet-5-5" });
  typeInto(lifetimeInput()!, "61");
  expect(dialog().textContent).toContain("At most 60 for a Claude model.");
  expect(button("Save").disabled).toBe(true);
  typeInto(lifetimeInput()!, "-1");
  expect(dialog().textContent).toContain("Enter whole minutes, 0 or more.");
  expect(button("Save").disabled).toBe(true);
});

test("a decision model has no cache lifetime", () => {
  render("openai-compatible", { ...MODEL, kind: "decision" });
  expect(lifetimeInput()).toBe(null);
});
