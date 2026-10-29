import { expect, test } from "bun:test";
import { act } from "react";
import { ChatInput } from "@/routes/window/chat/ChatInput";
import type { AgentMessageAttachment } from "@shared/agent-message-types";
import { onCleanup } from "../helpers/cleanup.js";
import { mountAsync, settle, settleUntil } from "../helpers/mount.js";

// The composer's image attachments: chosen or pasted, limited in number, type
// and size, shown as thumbnails, removable, and sent with the message. The
// harness registers no FileReader, which the composer reads images with:
// happy-dom's own reads its own File.
const dom = window as unknown as { File: typeof File; FileReader: typeof FileReader; Event: typeof Event };

function installDomFileReader() {
  const before = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
  Object.defineProperty(globalThis, "FileReader", { value: dom.FileReader, configurable: true, writable: true });
  onCleanup(() => {
    if (before) Object.defineProperty(globalThis, "FileReader", before);
    else delete (globalThis as { FileReader?: unknown }).FileReader;
  });
}

const PNG_BYTES = [137, 80, 78, 71];
const image = (name: string, type = "image/png", bytes: number[] | Uint8Array<ArrayBuffer> = PNG_BYTES) =>
  new dom.File([bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)], name, { type });

async function composer() {
  installDomFileReader();
  const sent: Array<{ content: string; attachments?: AgentMessageAttachment[] }> = [];
  const { host } = await mountAsync(<ChatInput onSend={(content, attachments) => sent.push({ content, attachments })} />);
  const fileInput = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  const textarea = host.querySelector("textarea")!;
  const choose = async (files: File[]) => {
    Object.defineProperty(fileInput, "files", { value: files, configurable: true });
    await act(async () => { fileInput.dispatchEvent(new dom.Event("change", { bubbles: true })); });
    await settle();
  };
  const paste = async (files: File[]) => {
    const event = new dom.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files } });
    await act(async () => { textarea.dispatchEvent(event); });
    await settle();
    return event.defaultPrevented;
  };
  const thumbnails = () => [...host.querySelectorAll<HTMLImageElement>("img")].map((img) => img.getAttribute("alt"));
  // Images are read asynchronously (FileReader): wait for what a choice leads to.
  const shown = (count: number) => settleUntil(() => thumbnails().length === count, `${count} thumbnails`);
  const error = () => host.querySelector(".text-destructive")?.textContent ?? "";
  const refused = (reason: string) => settleUntil(() => error() === reason, `error "${reason}"`);
  const send = async () => {
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.click(); });
    await settle();
  };
  return { host, sent, choose, paste, thumbnails, error, send, shown, refused };
}

test("a chosen image shows as a thumbnail and goes out with the message as base64", async () => {
  const c = await composer();
  await c.choose([image("screen.png")]);
  await c.shown(1);
  expect(c.thumbnails()).toEqual(["screen.png"]);
  await c.send();
  expect(c.sent.length).toBe(1);
  expect(c.sent[0]!.attachments).toMatchObject([{ type: "image", name: "screen.png", mediaType: "image/png", data: "iVBORw==", sizeBytes: 4 }]);
  expect(c.thumbnails()).toEqual([]);
});

test("four images at most: a fifth is refused with a reason and none of that batch is added", async () => {
  const c = await composer();
  await c.choose([image("1.png"), image("2.png"), image("3.png")]);
  await c.shown(3);
  await c.choose([image("4.png"), image("5.png")]);
  await c.refused("Attach up to 4 images.");
  expect(c.thumbnails()).toEqual(["1.png", "2.png", "3.png"]);
});

test("an image type the models do not take, or one over 5MB, is refused with the reason", async () => {
  const c = await composer();
  await c.choose([image("old.bmp", "image/bmp")]);
  await c.refused("Supported image types: PNG, JPEG, WebP, GIF.");
  await c.choose([image("huge.png", "image/png", new Uint8Array(5 * 1024 * 1024 + 1))]);
  await c.refused("Image must be 5MB or smaller.");
  expect(c.thumbnails()).toEqual([]);
  // A good one clears the reason.
  await c.choose([image("ok.png")]);
  await c.shown(1);
  expect(c.error()).toBe("");
  expect(c.thumbnails()).toEqual(["ok.png"]);
});

test("files that are not images are passed over", async () => {
  const c = await composer();
  await c.choose([new dom.File(["notes"], "notes.txt", { type: "text/plain" })]);
  expect(c.thumbnails()).toEqual([]);
  expect(c.error()).toBe("");
});

test("a pasted image is attached and kept out of the text; a paste with no image is left to the browser", async () => {
  const c = await composer();
  expect(await c.paste([image("clip.png")])).toBe(true);
  await c.shown(1);
  expect(c.thumbnails()).toEqual(["clip.png"]);
  expect(await c.paste([])).toBe(false);
  expect(c.thumbnails()).toEqual(["clip.png"]);
});

test("a thumbnail's remove button takes that image out", async () => {
  const c = await composer();
  await c.choose([image("a.png"), image("b.png")]);
  await c.shown(2);
  const removes = c.host.querySelectorAll<HTMLButtonElement>('button[aria-label="Remove image"]');
  await act(async () => { removes[0]!.click(); });
  expect(c.thumbnails()).toEqual(["b.png"]);
});

test("while an image is read under a busy agent, the typed message keeps a waiting Send, never Stop", async () => {
  installDomFileReader();
  const held: Array<() => void> = [];
  Object.defineProperty(globalThis, "FileReader", {
    value: class extends dom.FileReader { override readAsDataURL(blob: Blob) { held.push(() => super.readAsDataURL(blob)); } },
    configurable: true,
    writable: true
  });
  const { host } = await mountAsync(<ChatInput busyHint onCancel={() => {}} onSend={() => {}} />);
  const textarea = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), "value")?.set?.call(textarea, "and this");
    textarea.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "and this" }));
  });
  const fileInput = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(fileInput, "files", { value: [image("screen.png")], configurable: true });
  await act(async () => { fileInput.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  expect(held).toHaveLength(1);
  // A Stop under the pointer that was about to press Send would stop the agent.
  expect(host.querySelector('button[aria-label="Stop agent"]') === null).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.disabled).toBe(true);
  await act(async () => { held[0]!(); });
  await settleUntil(() => host.querySelectorAll("img").length === 1, "the thumbnail");
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.disabled).toBe(false);
});
