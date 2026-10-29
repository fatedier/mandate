import { expect, test } from "bun:test";
import { act, useState } from "react";
import { ProviderModels } from "@/routes/settings/ProviderModels";
import type { ModelForm } from "@/routes/settings/provider-form";
import type { SettingsConfigResponse } from "@/routes/settings/types";
import { mount } from "../helpers/mount.js";

// A provider's models: one row each, with its vendor's mark, its id, what
// Routing and Memory use it for, its protocol when not the default, and its
// image and reasoning; a row opens its edit dialog, its menu removes it.
// Each of these saves at once: the dialog closes when the save lands and
// keeps the change when it fails; a model in use cannot be removed.

const config = {
  models: { default: { model: "proxy/model-a", reasoningEffort: "provider-default", modelFallbacks: [{ model: "proxy/model-b", reasoningEffort: "provider-default" }] }, providers: {} },
  agent: { modelOverrides: { manager: false, worker: false, global: false }, managerModel: { model: "proxy/model-a" }, managerModelFallbacks: [], workerModel: { model: "proxy/model-a" }, workerModelFallbacks: [], globalModel: { model: "proxy/model-a" }, globalModelFallbacks: [] },
  memory: { embedding: { model: "proxy/embed-1" } }
} as unknown as SettingsConfigResponse;

const MODELS: ModelForm[] = [
  { id: "r1", modelId: "model-a", input: ["text", "image"], supportsReasoning: true, protocol: "messages", kind: "chat" },
  { id: "r2", modelId: "model-b", input: ["text"], supportsReasoning: false, protocol: "responses", kind: "chat" },
  { id: "r3", modelId: "embed-1", input: ["text"], supportsReasoning: false, protocol: "responses", kind: "chat" },
  { id: "r4", modelId: "model-c", input: ["text"], supportsReasoning: false, protocol: "responses", kind: "chat" }
];

let current: ModelForm[] = [];
let saves: ModelForm[][] = [];
/** The next save: lands, fails, or waits until released. */
let nextSave: "land" | "fail" | "hold" = "land";
let release: () => void = () => {};

function Harness({ initial, locked = false, settings = config }: { initial: ModelForm[]; locked?: boolean; settings?: SettingsConfigResponse }) {
  const [models, setModels] = useState(initial);
  current = models;
  return (
    <ProviderModels
      providerKey="proxy"
      providerType="openai-compatible"
      models={models}
      config={settings}
      catalog={{ models: [], source: "configured" }}
      locked={locked}
      onRefreshCatalog={() => {}}
      onSaveModels={async (next) => {
        saves.push(next);
        if (nextSave === "fail") throw new Error("settings write failed");
        if (nextSave === "hold") await new Promise<void>((resolve) => { release = resolve; });
        setModels(next);
      }}
    />
  );
}

function render(initial = MODELS, locked = false, settings = config): HTMLElement {
  current = [];
  saves = [];
  nextSave = "land";
  return mount(<Harness initial={initial} locked={locked} settings={settings} />).host;
}

const row = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-model-row="${id}"]`)!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const dialogButton = (text: string) => Array.from(dialog()!.querySelectorAll<HTMLButtonElement>("button")).find((el) => el.textContent?.trim() === text)!;
const radio = (text: string) => Array.from(dialog()!.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((el) => el.textContent?.includes(text))!;
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

async function edit(host: HTMLElement, id: string): Promise<void> {
  act(() => row(host, id).querySelector<HTMLButtonElement>("button")!.click());
  await flush();
}

async function openMenu(host: HTMLElement, id: string): Promise<void> {
  const trigger = row(host, id).querySelector<HTMLButtonElement>(`[aria-label="Actions for ${id}"]`)!;
  act(() => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
  await flush();
}

const menuItem = (text: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((el) => el.textContent?.trim() === text)!;

function inlineError(scope: ParentNode | null): { message: string; detail: string | null } | null {
  const el = scope?.querySelector('[data-slot="inline-error"]');
  if (!el) return null;
  return { message: el.querySelector("span")?.textContent ?? "", detail: el.querySelector("p")?.textContent ?? null };
}

test("each row: the id, what Routing and Memory use it for, its protocol when not Responses, and what it can do", () => {
  const host = render();
  const a = row(host, "model-a");
  expect(a.textContent).toContain("model-a");
  expect(a.textContent).toContain("Default");
  expect(a.textContent).toContain("Messages");
  expect(Array.from(a.querySelectorAll("[role=img]")).map((el) => el.getAttribute("aria-label"))).toEqual(["Image input", "Reasoning"]);
  const b = row(host, "model-b");
  expect(b.textContent).toContain("Fallback");
  expect(b.textContent).not.toContain("Responses");
  expect(b.querySelectorAll("[role=img]").length).toBe(0);
  // The embedding model is in use too, and says so.
  expect(row(host, "embed-1").textContent).toContain("Memory");
  expect(row(host, "model-c").textContent).not.toContain("Memory");
  // A screen reader hears the row as it reads, tags and all: its name is its
  // content, after a hidden "Edit ".
  const open = a.querySelector("button")!;
  expect(open.getAttribute("aria-label")).toBeNull();
  const heard = open.cloneNode(true) as HTMLElement;
  for (const hidden of Array.from(heard.querySelectorAll('[aria-hidden="true"]'))) hidden.remove();
  expect(heard.textContent).toBe("Edit model-aDefaultMessages");
  expect(open.querySelector(".sr-only")?.textContent).toBe("Edit ");
  expect(host.textContent).toContain("Models");
  expect(host.textContent).toContain("Add models");
});

test("the dialog's Save is off until something changes; Save saves the model and closes", async () => {
  const host = render();
  await edit(host, "model-b");
  expect(dialogButton("Save").disabled).toBe(true);
  act(() => radio("Chat Completions").click());
  expect(dialogButton("Save").disabled).toBe(false);
  act(() => dialogButton("Save").click());
  await flush();
  expect(saves.map((models) => models.find((m) => m.modelId === "model-b")?.protocol)).toStrictEqual(["chat"]);
  expect(dialog() === null).toBe(true);
  expect(row(host, "model-b").textContent).toContain("Chat Completions");
});

test("while its save is on its way the dialog says Saving… and does not close", async () => {
  const host = render();
  await edit(host, "model-b");
  act(() => radio("Chat Completions").click());
  nextSave = "hold";
  act(() => dialogButton("Save").click());
  await flush();
  expect(dialogButton("Saving…").disabled).toBe(true);
  expect(dialogButton("Cancel").disabled).toBe(true);
  // What it is saving cannot change under it: a choice made now would be
  // closed away unsaved.
  expect(radio("Messages").disabled).toBe(true);
  expect(Array.from(dialog()!.querySelectorAll<HTMLButtonElement>('[role="switch"]')).map((el) => el.disabled)).toEqual([true, true]);
  // Escape does not close it either.
  act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await flush();
  expect(dialog()).not.toBeNull();
  await act(async () => { release(); });
  await flush();
  expect(dialog() === null).toBe(true);
});

test("a save that fails keeps the dialog open with the change, and says why", async () => {
  const host = render();
  await edit(host, "model-b");
  act(() => radio("Chat Completions").click());
  nextSave = "fail";
  act(() => dialogButton("Save").click());
  await flush();
  expect(dialog()).not.toBeNull();
  expect(inlineError(dialog())).toEqual({ message: "Couldn't save.", detail: "settings write failed" });
  expect(radio("Chat Completions").getAttribute("aria-checked")).toBe("true");
  expect(dialogButton("Save").disabled).toBe(false);
  expect(current.find((m) => m.modelId === "model-b")?.protocol).toBe("responses");
});

test("a model no one uses is removed from its menu at once", async () => {
  const host = render();
  await openMenu(host, "model-c");
  act(() => menuItem("Remove").click());
  await flush();
  expect(saves.map((models) => models.map((m) => m.modelId))).toStrictEqual([["model-a", "model-b", "embed-1"]]);
  expect(host.querySelector('[data-model-row="model-c"]') === null).toBe(true);
});

test("a removal that fails keeps the row and says why", async () => {
  const host = render();
  nextSave = "fail";
  await openMenu(host, "model-c");
  act(() => menuItem("Remove").click());
  await flush();
  expect(row(host, "model-c")).not.toBeNull();
  expect(inlineError(host)).toEqual({ message: "Couldn't remove model-c.", detail: "settings write failed" });
});

test("a model in use cannot be removed: its Remove is off and says what uses it", async () => {
  const host = render();
  const reason = async (id: string) => {
    await openMenu(host, id);
    const item = menuItem("Remove");
    const line = document.querySelector('[data-slot="remove-blocked"]')?.textContent ?? null;
    const disabled = item.getAttribute("data-disabled") !== null;
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await flush();
    return [disabled, line];
  };
  expect(await reason("model-a")).toEqual([true, "In use by Routing (default model). Change that first."]);
  expect(await reason("embed-1")).toEqual([true, "In use by Memory embeddings. Change that first."]);
  expect(await reason("model-c")).toEqual([false, null]);
  expect(saves).toStrictEqual([]);
});

test("while another write is on its way, the dialog's Save, Remove and Add are off", async () => {
  const host = render(MODELS, true);
  await edit(host, "model-b");
  act(() => radio("Chat Completions").click());
  expect(dialogButton("Save").disabled).toBe(true);
  act(() => dialogButton("Cancel").click());
  await flush();
  await openMenu(host, "model-c");
  expect(menuItem("Remove").getAttribute("data-disabled")).not.toBeNull();
  act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await flush();
  act(() => Array.from(host.querySelectorAll("button")).find((el) => el.textContent?.includes("Add models"))!.click());
  await flush();
  const field = dialog()!.querySelector<HTMLInputElement>('input[aria-label="Model id"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, "model-d");
    field.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  });
  act(() => dialogButton("Add").click());
  expect(dialogButton("Add 1 model").disabled).toBe(true);
});

test("while Add's save is on its way, the picks cannot change", async () => {
  const host = render();
  act(() => Array.from(host.querySelectorAll("button")).find((el) => el.textContent?.includes("Add models"))!.click());
  await flush();
  const field = dialog()!.querySelector<HTMLInputElement>('input[aria-label="Model id"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, "model-d");
    field.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  });
  act(() => dialogButton("Add").click());
  nextSave = "hold";
  act(() => dialogButton("Add 1 model").click());
  await flush();
  expect(dialogButton("Adding…").disabled).toBe(true);
  expect(field.disabled).toBe(true);
  expect(dialog()!.querySelector<HTMLInputElement>('[data-catalog-item="model-d"] input')!.disabled).toBe(true);
  await act(async () => { release(); });
  await flush();
  expect(dialog() === null).toBe(true);
});

test("Add models saves the models it adds and closes; one that fails stays open and says why", async () => {
  const host = render();
  const addById = async (id: string) => {
    act(() => Array.from(host.querySelectorAll("button")).find((el) => el.textContent?.includes("Add models"))!.click());
    await flush();
    const field = dialog()!.querySelector<HTMLInputElement>('input[aria-label="Model id"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, id);
      field.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
    });
    act(() => Array.from(dialog()!.querySelectorAll("button")).find((el) => el.textContent?.trim() === "Add")!.click());
    act(() => Array.from(dialog()!.querySelectorAll("button")).find((el) => el.textContent?.trim() === "Add 1 model")!.click());
    await flush();
  };
  await addById("model-d");
  expect(saves.map((models) => models.map((m) => m.modelId))).toStrictEqual([["model-a", "model-b", "embed-1", "model-c", "model-d"]]);
  expect(dialog() === null).toBe(true);
  expect(row(host, "model-d")).not.toBeNull();
  nextSave = "fail";
  await addById("model-e");
  expect(dialog()).not.toBeNull();
  expect(inlineError(dialog())).toEqual({ message: "Couldn't save.", detail: "settings write failed" });
  expect(host.querySelector('[data-model-row="model-e"]') === null).toBe(true);
});

test("no models: a line that says how to start", () => {
  expect(render([]).textContent).toContain("No models yet — Add models to use this provider.");
});
