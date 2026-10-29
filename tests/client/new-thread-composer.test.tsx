import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { NewThreadComposer } from "@/routes/threads/NewThreadComposer";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mountAsync, settle, settleUntil } from "../helpers/mount.js";
import { managerThreadDto } from "../helpers/client-builders.js";

afterEach(() => {
  runCleanups();
  useManagerThreadsStore.setState(useManagerThreadsStore.getInitialState(), true);
});

/** The composer with "Plan the release" typed, and the first messages it sends. */
async function composer() {
  const sent: string[] = [];
  useManagerThreadsStore.setState({
    create: async ({ content }: { content: string }) => {
      sent.push(content);
      return { id: "thread_1" } as Awaited<ReturnType<ReturnType<typeof useManagerThreadsStore.getState>["create"]>>;
    }
  });
  const { host } = await mountAsync(<MemoryRouter><NewThreadComposer /></MemoryRouter>);
  const textarea = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), "value")?.set?.call(textarea, "Plan the release");
    textarea.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "Plan the release" }));
  });
  const press = (init: KeyboardEventInit) => act(async () => {
    textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
  });
  return { textarea, sent, press };
}

test("Enter sends the first message", async () => {
  const { sent, press } = await composer();
  await press({});
  await settle();
  expect(sent).toStrictEqual(["Plan the release"]);
});

test("Enter with Cmd or Ctrl held does not send, as in a thread's composer", async () => {
  const { sent, press } = await composer();
  await press({ metaKey: true });
  await press({ ctrlKey: true });
  await settle();
  expect(sent).toStrictEqual([]);
});

test("the Enter that confirms an IME candidate does not send", async () => {
  const { textarea, sent, press } = await composer();
  await act(async () => { textarea.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true })); });
  await press({});
  // Safari can report the confirming Enter after compositionend, with
  // isComposing false: its keyCode, 229, is what still says so.
  await act(async () => { textarea.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  await press({ keyCode: 229 });
  await settle();
  expect(sent).toStrictEqual([]);
});

// One composer: Home's is the thread's own — the same card,
// send button and hint — and its first message can carry images, which the
// server already took.
const dom = window as unknown as { File: typeof File; FileReader: typeof FileReader; Event: typeof Event };

async function composerWith(create: (input: { content?: string; attachments?: unknown[] }) => Promise<{ id: string }>) {
  const before = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
  Object.defineProperty(globalThis, "FileReader", { value: dom.FileReader, configurable: true, writable: true });
  onCleanup(() => {
    if (before) Object.defineProperty(globalThis, "FileReader", before);
    else delete (globalThis as { FileReader?: unknown }).FileReader;
  });
  useManagerThreadsStore.setState({ create: create as never });
  const { host } = await mountAsync(<MemoryRouter><NewThreadComposer /></MemoryRouter>);
  const textarea = host.querySelector("textarea")!;
  const type = (text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), "value")?.set?.call(textarea, text);
    textarea.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  });
  const start = () => act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Start thread"]')!.click(); });
  return { host, textarea, type, start };
}

test("Home's composer is the thread's: the same card, send button, hint and Attach image", async () => {
  const { host } = await composerWith(async () => ({ id: "thread_1" }));
  expect(host.querySelector('[data-slot="composer"]') === null).toBe(false);
  expect(host.querySelector('[data-slot="composer"] textarea')?.getAttribute("placeholder")).toBe("Start a new thread");
  expect(host.querySelector('button[aria-label="Attach image"]') === null).toBe(false);
  expect(host.textContent).toContain("to send");
  // Nothing typed: the neutral send, as in a thread.
  expect(host.querySelector('button[aria-label="Start thread"]')!.className.split(/\s+/)).toContain("bg-sel");
});

test("the first message can carry images", async () => {
  const calls: Array<{ content?: string; attachments?: unknown[] }> = [];
  const { host, type, start } = await composerWith(async (input) => { calls.push(input); return { id: "thread_1" }; });
  await type("What is wrong here?");
  const file = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(file, "files", { value: [new dom.File([new Uint8Array([137, 80, 78, 71])], "screen.png", { type: "image/png" })], configurable: true });
  await act(async () => { file.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  await settleUntil(() => host.querySelectorAll("img").length === 1, "the thumbnail");
  await start();
  await settle();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ content: "What is wrong here?", attachments: [{ type: "image", name: "screen.png", mediaType: "image/png" }] });
});

test("a thread that could not be started keeps what was typed", async () => {
  const { textarea, type, start } = await composerWith(async () => { throw new Error("offline"); });
  await type("Plan the release");
  await start();
  await settle();
  expect(textarea.value).toBe("Plan the release");
});

test("while the thread is being started, a second send starts nothing more", async () => {
  let calls = 0;
  let finish!: (value: { id: string }) => void;
  const { type, start } = await composerWith(() => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  await type("Plan the release");
  await start();
  await start();
  expect(calls).toBe(1);
  await act(async () => { finish({ id: "thread_1" }); });
});

test("while the thread is being started, no image can join a message already on its way", async () => {
  let finish!: (value: { id: string }) => void;
  const { host, type, start } = await composerWith(() => new Promise((resolve) => { finish = resolve; }));
  await type("Plan the release");
  await start();
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="Attach image"]')!.disabled).toBe(true);
  // A file that arrives anyway is not even read: it would join a draft about
  // to be cleared. Counted where the read starts, synchronously, since a
  // thumbnail check would pass before any read could finish.
  let reads = 0;
  Object.defineProperty(globalThis, "FileReader", {
    value: class extends dom.FileReader { constructor() { super(); reads++; } },
    configurable: true,
    writable: true
  });
  const file = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(file, "files", { value: [new dom.File([new Uint8Array([137, 80, 78, 71])], "late.png", { type: "image/png" })], configurable: true });
  await act(async () => { file.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  expect(reads).toBe(0);
  await act(async () => { finish({ id: "thread_1" }); });
});

test("an image still being read is part of the message: neither Send nor Enter starts the thread before it lands", async () => {
  const calls: Array<{ content?: string; attachments?: unknown[] }> = [];
  const { host, textarea, type, start } = await composerWith(async (input) => { calls.push(input); return { id: "thread_1" }; });
  // Reads finish only when released, as a large image's would, later.
  const held: Array<() => void> = [];
  Object.defineProperty(globalThis, "FileReader", {
    value: class extends dom.FileReader { override readAsDataURL(blob: Blob) { held.push(() => super.readAsDataURL(blob)); } },
    configurable: true,
    writable: true
  });
  await type("What is wrong here?");
  const file = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(file, "files", { value: [new dom.File([new Uint8Array([137, 80, 78, 71])], "screen.png", { type: "image/png" })], configurable: true });
  await act(async () => { file.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  expect(held).toHaveLength(1);
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="Start thread"]')!.disabled).toBe(true);
  await act(async () => { textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  await settle();
  expect(calls).toHaveLength(0);
  await act(async () => { held[0]!(); });
  await settleUntil(() => host.querySelectorAll("img").length === 1, "the thumbnail");
  await start();
  await settle();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ content: "What is wrong here?", attachments: [{ name: "screen.png" }] });
});

test("an image that could not be read leaves the text sendable", async () => {
  const calls: Array<{ content?: string }> = [];
  const { host, type, start } = await composerWith(async (input) => { calls.push(input); return { id: "thread_1" }; });
  await type("What is wrong here?");
  const file = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(file, "files", { value: [new dom.File([new Uint8Array([66, 77])], "screen.bmp", { type: "image/bmp" })], configurable: true });
  await act(async () => { file.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  await settleUntil(() => host.textContent!.includes("Supported image types"), "the error");
  await start();
  await settle();
  expect(calls).toMatchObject([{ content: "What is wrong here?" }]);
});


// Home's composer offers @ too: a new thread's first message names the
// threads it was picked for.
test("Home's first message carries its mentions to the new thread", async () => {
  const created: Array<{ content?: string; mentions?: unknown }> = [];
  const original = globalThis.getComputedStyle;
  onCleanup(() => { globalThis.getComputedStyle = original; });
  globalThis.getComputedStyle = (() => ({ lineHeight: "20px" })) as unknown as typeof globalThis.getComputedStyle;
  const general = managerThreadDto("thr_general", { title: "General", createdAt: "2026-10-17T00:00:00.000Z", lastActivityAt: "2026-10-17T00:00:00.000Z" });
  useManagerThreadsStore.setState({
    threads: new Map([[general.id, general]]),
    create: async (input: { content?: string; mentions?: unknown }) => {
      created.push(input);
      return { id: "thread_1" } as Awaited<ReturnType<ReturnType<typeof useManagerThreadsStore.getState>["create"]>>;
    }
  });
  const { host } = await mountAsync(<MemoryRouter><NewThreadComposer /></MemoryRouter>);
  const textarea = host.querySelector("textarea")!;
  const type = (text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), "value")?.set?.call(textarea, text);
    textarea.setSelectionRange(text.length, text.length);
    textarea.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  });
  const enter = () => act(async () => {
    textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  await type("Continue @Gen");
  await enter();
  expect(textarea.value).toBe("Continue @General ");
  await enter();
  await settleUntil(() => created.length === 1, "the new thread to be created");
  expect(created[0]).toMatchObject({ content: "Continue @General", mentions: [{ kind: "thread", id: "thr_general", label: "General" }] });
});
