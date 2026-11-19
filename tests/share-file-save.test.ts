import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Hono } from "hono";
import { tempDir } from "./helpers/temp.js";
import { mountShareFileRoutes } from "../src/server/modules/files/share-file-save.js";
import { API_PATHS } from "../src/shared/api-contracts.js";

// The desktop app's webview has no downloads: a shared image or text is
// written into the Downloads folder by the server, under a name of its own,
// never over a file that is there.

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function setup(maxBytes?: number) {
  const downloads = path.join(tempDir("md-share-"), "Downloads");
  const app = new Hono();
  mountShareFileRoutes(app, { downloadsDir: downloads, now: () => new Date(2026, 10, 6, 19, 30, 5), ...(maxBytes ? { maxBytes } : {}) });
  const post = async (body: Uint8Array | string, type: string) => {
    const res = await app.request(API_PATHS.shareFiles, { method: "POST", headers: { "Content-Type": type }, body: typeof body === "string" ? body : new Blob([new Uint8Array(body)]) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  return { downloads, post };
}

test("an image is saved into Downloads under a dated name, a second one beside it, never over it", async () => {
  const { downloads, post } = setup();
  const first = await post(PNG, "image/png");
  expect(first).toEqual({ status: 200, body: { path: path.join(downloads, "mandate-share-20261106-193005.png") } });
  expect(Buffer.compare(fs.readFileSync(String(first.body.path)), PNG)).toBe(0);
  const second = await post(PNG, "image/png");
  expect(second.body.path).toBe(path.join(downloads, "mandate-share-20261106-193005-2.png"));
  expect(fs.readdirSync(downloads).sort()).toEqual(["mandate-share-20261106-193005-2.png", "mandate-share-20261106-193005.png"]);
});

test("Markdown is saved as a .md file, its text as sent", async () => {
  const { post } = setup();
  const text = "**You:** 面包店明天几点开门？\n\n早上八点。\n";
  const saved = await post(text, "text/markdown; charset=utf-8");
  expect(saved.status).toBe(200);
  expect(String(saved.body.path)).toEndWith("mandate-share-20261106-193005.md");
  expect(fs.readFileSync(String(saved.body.path), "utf8")).toBe(text);
});

test("anything but a PNG or UTF-8 Markdown is refused, and so is a body over the cap; nothing is written", async () => {
  const { downloads, post } = setup(64);
  expect(await post(Buffer.from("<html>not an image</html>"), "image/png")).toMatchObject({ status: 400, body: { code: "invalid" } });
  expect(await post(new Uint8Array([0xff, 0xfe, 0xfd]), "text/markdown")).toMatchObject({ status: 400, body: { code: "invalid" } });
  expect(await post("plain", "text/plain")).toMatchObject({ status: 400, body: { code: "invalid" } });
  expect(await post(Buffer.concat([PNG, Buffer.alloc(64)]), "image/png")).toMatchObject({ status: 413, body: { code: "too_large" } });
  expect(fs.existsSync(downloads) ? fs.readdirSync(downloads) : []).toEqual([]);
});
