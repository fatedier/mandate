import { expect, test } from "bun:test";
import fs from "node:fs";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { onCleanup } from "./helpers/cleanup.js";
import { MODEL_IMAGE_LONG_SIDE, ModelImageFitter } from "../src/server/modules/agent/model-images.js";

// An image a model is sent is at most 2000 px on its longer side: a provider
// may refuse a long, narrow screenshot whose 2000 px copy it takes.
// The stored image is left as it is: the page shows the original.

const ICON = new Uint8Array(fs.readFileSync("assets/pwa/icon-512.png"));
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const sized = async (width: number, height: number, kind: "png" | "jpeg" = "png") => {
  const image = new Bun.Image(ICON).resize(width, height);
  return (kind === "png" ? image.png() : image.jpeg()).bytes();
};

function thread(images: { tall: Uint8Array; wide: Uint8Array; small: Uint8Array }) {
  const env = freshStoresEnv("md-model-images-");
  onCleanup(() => env.cleanup());
  const t = env.agentStore.createManagerThread("Report page");
  const attached = (id: string, bytes: Uint8Array, mediaType: string) => ({ type: "image" as const, id, name: `${id}.img`, mediaType, data: base64(bytes), sizeBytes: bytes.length });
  env.agentStore.appendMessage({ threadId: t.id, role: "user", source: "user", content: { type: "text", text: "look", attachments: [attached("att_tall", images.tall, "image/png"), attached("att_small", images.small, "image/png")] } });
  env.agentStore.appendMessage({ threadId: t.id, role: "tool", source: "self", content: { type: "tool_result", toolCallId: "c1", toolName: "view_image", result: { type: "view_image_result", message: "Viewed image: wide.jpg", image: { ...attached("img_wide", images.wide, "image/jpeg"), name: "wide.jpg", displayPath: "wide.jpg" } } } });
  return { env, messages: () => env.agentStore.getActiveMessages(t.id) };
}

const metaOf = (data: string) => new Bun.Image(new Uint8Array(Buffer.from(data, "base64"))).metadata();

test("an image longer than 2000 px on a side goes at 2000, in its own kind; the stored one is left", async () => {
  const images = { tall: await sized(600, 9000), wide: await sized(3000, 1000, "jpeg"), small: await sized(1200, 800) };
  const { messages } = thread(images);
  const fitter = new ModelImageFitter();
  const [said, viewed] = messages();
  const fitted = await fitter.prepare([said!, viewed!]);
  const tall = fitted.forModel({ id: "att_tall", data: base64(images.tall), mediaType: "image/png" }, said!.id)!;
  expect(tall.mediaType).toBe("image/png");
  expect(await metaOf(tall.data)).toMatchObject({ format: "png", width: 133, height: MODEL_IMAGE_LONG_SIDE });
  const wide = fitted.forModel({ id: "img_wide", data: base64(images.wide), mediaType: "image/jpeg" }, viewed!.id)!;
  expect(wide.mediaType).toBe("image/jpeg");
  expect(await metaOf(wide.data)).toMatchObject({ format: "jpeg", width: MODEL_IMAGE_LONG_SIDE, height: 667 });
  // Within 2000 px: as it is.
  expect(fitted.forModel({ id: "att_small", data: base64(images.small), mediaType: "image/png" }, said!.id)).toBeNull();
  expect(JSON.stringify(said!.content)).toContain(base64(images.tall));
  expect(JSON.stringify(viewed!.content)).toContain(base64(images.wide));
}, 30_000);

test("an image is fitted once; another message's, or one Bun cannot read, goes as it is", async () => {
  const images = { tall: await sized(600, 9000), wide: await sized(3000, 1000, "jpeg"), small: await sized(1200, 800) };
  const { messages } = thread(images);
  let fits = 0;
  const fitter = new ModelImageFitter({ fit: async () => { fits += 1; return { data: "AAAA", mediaType: "image/png" }; } });
  const first = await fitter.prepare(messages());
  const again = await fitter.prepare(messages());
  expect(fits).toBe(3);
  const said = messages()[0]!;
  expect(again.forModel({ id: "att_tall", data: base64(images.tall), mediaType: "image/png" }, said.id)).toEqual({ data: "AAAA", mediaType: "image/png" });
  // Another message's image of that id is not this one.
  expect(first.forModel({ id: "att_tall", data: base64(images.tall), mediaType: "image/png" }, "msg_other")).toBeNull();
  const garbled = new ModelImageFitter();
  const bytes = new Uint8Array(4096).map((_, i) => (i * 7) % 251);
  const env = freshStoresEnv("md-model-images-bad-");
  onCleanup(() => env.cleanup());
  const t = env.agentStore.createManagerThread("x");
  env.agentStore.appendMessage({ threadId: t.id, role: "user", source: "user", content: { type: "text", text: "", attachments: [{ type: "image", id: "bad", mediaType: "image/png", data: base64(bytes), sizeBytes: bytes.length }] } });
  const active = env.agentStore.getActiveMessages(t.id);
  const fittedBad = await garbled.prepare(active);
  expect(fittedBad.forModel({ id: "bad", data: base64(bytes), mediaType: "image/png" }, active[0]!.id)).toBeNull();
}, 30_000);

// A prompt keeps the copies made for it: the shared cache letting the oldest
// go (or another thread's images pushing them out) must not send an original
// in their place.
test("a prompt keeps every image fitted for it, though the cache let some go", async () => {
  const images = { tall: await sized(600, 9000), wide: await sized(3000, 1000, "jpeg"), small: await sized(2400, 900) };
  const { messages } = thread(images);
  const fitter = new ModelImageFitter({ keepBytes: 1, fit: async (bytes) => ({ data: base64(bytes.slice(0, 12)), mediaType: "image/png" }) });
  const active = messages();
  const fitted = await fitter.prepare(active);
  const [said, viewed] = active;
  expect(fitted.forModel({ id: "att_tall", data: base64(images.tall), mediaType: "image/png" }, said!.id)).not.toBeNull();
  expect(fitted.forModel({ id: "att_small", data: base64(images.small), mediaType: "image/png" }, said!.id)).not.toBeNull();
  expect(fitted.forModel({ id: "img_wide", data: base64(images.wide), mediaType: "image/jpeg" }, viewed!.id)).not.toBeNull();
}, 30_000);

// A screenshot viewed again under the same path keeps its image id; two such,
// of one length, are still two images.
test("two images under one id and one length are told apart by their message", async () => {
  const env = freshStoresEnv("md-model-images-same-id-");
  onCleanup(() => env.cleanup());
  const t = env.agentStore.createManagerThread("x");
  const before = new Uint8Array(3000).fill(1);
  const after = new Uint8Array(3000).fill(2);
  const view = (bytes: Uint8Array) => env.agentStore.appendMessage({ threadId: t.id, role: "tool", source: "self", content: { type: "tool_result", toolCallId: "c", toolName: "view_image", result: { type: "view_image_result", message: "Viewed image: page.png", image: { type: "image", id: "img_same", name: "page.png", displayPath: "page.png", mediaType: "image/png", data: base64(bytes), sizeBytes: bytes.length } } } });
  const first = view(before);
  const second = view(after);
  const fitter = new ModelImageFitter({ fit: async (bytes) => ({ data: `FIT-${bytes[0]}`, mediaType: "image/png" }) });
  const fitted = await fitter.prepare(env.agentStore.getActiveMessages(t.id));
  expect(fitted.forModel({ id: "img_same", data: base64(before), mediaType: "image/png" }, first.id)?.data).toBe("FIT-1");
  expect(fitted.forModel({ id: "img_same", data: base64(after), mediaType: "image/png" }, second.id)?.data).toBe("FIT-2");
});
