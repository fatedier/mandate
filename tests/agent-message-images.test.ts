import { expect, test } from "bun:test";
import fs from "node:fs";
import { Hono } from "hono";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { onCleanup } from "./helpers/cleanup.js";
import { toAgentClientMessage } from "../src/server/modules/agent/agent-message-dto.js";
import { mountMessageImageRoutes } from "../src/server/modules/agent/message-images.js";
import { API_PATHS } from "../src/shared/api-contracts.js";

// A chat page carries each image's address, not its bytes: the bytes come
// when an image is drawn, a thumbnail for the transcript and the original
// when it is opened. The stored message keeps them, for the model.

const ICON = new Uint8Array(fs.readFileSync("assets/pwa/icon-512.png")); // 512×512, under 64 KB

function setup() {
  const env = freshStoresEnv("md-message-images-");
  onCleanup(() => env.cleanup());
  const thread = env.agentStore.createManagerThread("Report page");
  const app = new Hono();
  mountMessageImageRoutes(app, { agentStore: env.agentStore });
  return { env, thread, app };
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const viewed = (id: string, bytes: Uint8Array, mediaType = "image/png") => ({
  type: "tool_result" as const, toolCallId: "call_1", toolName: "view_image",
  result: { type: "view_image_result", message: "Viewed image: report.png", image: { type: "image", id, name: "report.png", displayPath: "report.png", mediaType, data: base64(bytes), sizeBytes: bytes.length } }
});
const attached = (id: string, bytes: Uint8Array, mediaType = "image/png") => ({ type: "image" as const, id, name: "screen.png", mediaType, data: base64(bytes), sizeBytes: bytes.length });

test("a page carries each image's address in place of its bytes; the stored message keeps them", () => {
  const { env, thread } = setup();
  const said = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Look at this.", attachments: [attached("att_1", ICON)] } });
  const tool = env.agentStore.appendMessage({ threadId: thread.id, role: "tool", source: "self", content: viewed("img_1", ICON) });

  const page = [toAgentClientMessage(said), toAgentClientMessage(tool)];
  expect(page[0]!.content).toMatchObject({ attachments: [{ id: "att_1", mediaType: "image/png", sizeBytes: ICON.length, data: "", url: API_PATHS.agentMessageImage(said.id, "att_1") }] });
  expect(page[1]!.content).toMatchObject({ result: { message: "Viewed image: report.png", image: { id: "img_1", data: "", url: API_PATHS.agentMessageImage(tool.id, "img_1") } } });
  expect(JSON.stringify(page)).not.toContain(base64(ICON).slice(0, 200));

  const stored = env.agentStore.getMessageById(tool.id)!;
  expect(JSON.stringify(stored.content)).toContain(base64(ICON));
});

test("an image's address serves the original, kept a year by the browser that asked", async () => {
  const { env, thread, app } = setup();
  const said = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "", attachments: [attached("att_1", ICON)] } });
  const response = await app.request(API_PATHS.agentMessageImage(said.id, "att_1"));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(ICON);
});

test("a thumbnail is a WebP at most 400 wide; a small image is its own thumbnail", async () => {
  const { env, thread, app } = setup();
  const tall = await new Bun.Image(ICON).resize(1200, 4200).png().bytes();
  const big = env.agentStore.appendMessage({ threadId: thread.id, role: "tool", source: "self", content: viewed("img_tall", tall) });
  const small = env.agentStore.appendMessage({ threadId: thread.id, role: "tool", source: "self", content: viewed("img_small", ICON) });

  const thumb = await app.request(`${API_PATHS.agentMessageImage(big.id, "img_tall")}?size=thumb`);
  expect(thumb.status).toBe(200);
  expect(thumb.headers.get("content-type")).toBe("image/webp");
  expect(thumb.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  const bytes = new Uint8Array(await thumb.arrayBuffer());
  expect(await new Bun.Image(bytes).metadata()).toMatchObject({ format: "webp", width: 400, height: 1400 });
  expect(bytes.length < tall.length / 4).toBe(true);

  const same = await app.request(`${API_PATHS.agentMessageImage(small.id, "img_small")}?size=thumb`);
  expect(same.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await same.arrayBuffer())).toEqual(ICON);
});

test("an image that cannot be made smaller is served whole", async () => {
  const { env, thread, app } = setup();
  const garbled = new Uint8Array(80 * 1024).map((_, i) => (i * 31) % 251);
  const tool = env.agentStore.appendMessage({ threadId: thread.id, role: "tool", source: "self", content: viewed("img_bad", garbled) });
  const response = await app.request(`${API_PATHS.agentMessageImage(tool.id, "img_bad")}?size=thumb`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(garbled);
});

test("only a raster image of the message named is served", async () => {
  const { env, thread, app } = setup();
  const tool = env.agentStore.appendMessage({ threadId: thread.id, role: "tool", source: "self", content: viewed("img_1", ICON) });
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const vector = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "", attachments: [attached("att_svg", svg, "image/svg+xml")] } });
  for (const path of [
    API_PATHS.agentMessageImage("msg_nope", "img_1"),
    API_PATHS.agentMessageImage(tool.id, "img_other"),
    API_PATHS.agentMessageImage(vector.id, "att_svg")
  ]) {
    expect((await app.request(path)).status).toBe(404);
  }
});

// A thumbnail decodes the whole image: past a size, or more than a couple at
// once, the server's memory runs out (a few very tall screenshots at once
// take hundreds of MiB). Past the cap the original is served; beyond two, the
// rest wait their turn.
test("an image with more pixels than a thumbnail decodes is served whole", async () => {
  const { env, thread, app } = setup();
  const huge = await new Bun.Image(ICON).resize(6000, 5000).png().bytes();
  const tool = env.agentStore.appendMessage({ threadId: thread.id, role: "tool", source: "self", content: viewed("img_huge", huge) });
  const response = await app.request(`${API_PATHS.agentMessageImage(tool.id, "img_huge")}?size=thumb`);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(huge));
}, 30_000);

test("no more than two thumbnails are made at once; the rest wait and are still made", async () => {
  const env = freshStoresEnv("md-message-images-gate-");
  onCleanup(() => env.cleanup());
  const thread = env.agentStore.createManagerThread("Report page");
  let running = 0;
  let most = 0;
  const app = new Hono();
  mountMessageImageRoutes(app, {
    agentStore: env.agentStore,
    makeThumbnail: async () => {
      most = Math.max(most, ++running);
      await Bun.sleep(30);
      running -= 1;
      return new Uint8Array(10);
    }
  });
  const tall = await new Bun.Image(ICON).resize(1200, 4200).png().bytes();
  const ids = [1, 2, 3, 4, 5].map((n) => env.agentStore.appendMessage({ threadId: thread.id, role: "tool", source: "self", content: viewed(`img_${n}`, tall) }).id);
  const answers = await Promise.all(ids.map((id, i) => app.request(`${API_PATHS.agentMessageImage(id, `img_${i + 1}`)}?size=thumb`)));
  expect(answers.map((answer) => answer.headers.get("content-type"))).toEqual(Array(5).fill("image/webp"));
  expect(most).toBe(2);
}, 30_000);

// Waiting its turn, a thumbnail holds only its address: the image is read
// from its message once it is let in.
test("a thumbnail waiting its turn has not read its image yet", async () => {
  const env = freshStoresEnv("md-message-images-admit-");
  onCleanup(() => env.cleanup());
  const thread = env.agentStore.createManagerThread("Report page");
  const tall = await new Bun.Image(ICON).resize(1200, 4200).png().bytes();
  const ids = [1, 2, 3, 4, 5].map((n) => env.agentStore.appendMessage({ threadId: thread.id, role: "tool", source: "self", content: viewed(`img_${n}`, tall) }).id);
  let reads = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const app = new Hono();
  mountMessageImageRoutes(app, {
    agentStore: { getMessageById: (id) => { reads += 1; return env.agentStore.getMessageById(id); } },
    makeThumbnail: async () => { await held; return new Uint8Array(10); }
  });
  const answers = Promise.all(ids.map((id, i) => app.request(`${API_PATHS.agentMessageImage(id, `img_${i + 1}`)}?size=thumb`)));
  await Bun.sleep(50);
  expect(reads).toBe(2);
  release();
  expect((await answers).map((answer) => answer.status)).toEqual([200, 200, 200, 200, 200]);
  expect(reads).toBe(5);
}, 30_000);

// A page that has gone no longer needs its thumbnails: one still waiting
// leaves the queue, and is not made.
test("a thumbnail asked for by a page that has gone is not made", async () => {
  const env = freshStoresEnv("md-message-images-abort-");
  onCleanup(() => env.cleanup());
  const thread = env.agentStore.createManagerThread("Report page");
  const tall = await new Bun.Image(ICON).resize(1200, 4200).png().bytes();
  const ids = [1, 2, 3, 4, 5].map((n) => env.agentStore.appendMessage({ threadId: thread.id, role: "tool", source: "self", content: viewed(`img_${n}`, tall) }).id);
  const made: number[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const app = new Hono();
  mountMessageImageRoutes(app, {
    agentStore: env.agentStore,
    makeThumbnail: async (bytes) => { made.push(bytes.length); await held; return new Uint8Array(10); }
  });
  const ask = (i: number, signal?: AbortSignal) => app.request(`${API_PATHS.agentMessageImage(ids[i]!, `img_${i + 1}`)}?size=thumb`, signal ? { signal } : {});
  const gone = [new AbortController(), new AbortController()];
  const answers = [ask(0), ask(1), ask(2, gone[0]!.signal), ask(3, gone[1]!.signal), ask(4)];
  await Bun.sleep(50);
  for (const page of gone) page.abort();
  // They leave at once, while the two let in still hold their turns.
  const left = await Promise.race([Promise.all([answers[2]!, answers[3]!]), Bun.sleep(500).then(() => null)]);
  expect(left?.map((answer) => answer.status)).toEqual([499, 499]);
  release();
  const statuses = (await Promise.all(answers)).map((answer) => answer.status);
  expect(made).toHaveLength(3);
  expect([statuses[0], statuses[1], statuses[4]]).toEqual([200, 200, 200]);
}, 30_000);
