import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { buildApp } from "../src/server/app/http-app";
import type { AppDeps } from "../src/server/app/deps";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store";
import { freshAgentEnv } from "../tests/helpers/fixtures";
import { startWorkspaceFixture } from "./helpers/workspace-fixture";

test("Canvas reloads reuse HTTP bodies and show document and attachment updates", async () => {
  const env = freshAgentEnv("mandate-canvas-cache-browser-");
  const canvasStore = new CanvasStore(env.store.db, env.dir);
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const canvas = canvasStore.create({ title: "Cache check", scope: "manager", scopeId: null, threadId: thread.id });
  const assetPath = path.join(path.dirname(canvas.filePath!), "label.js");
  const documentPath = `/api/canvas/${canvas.id}`;
  const resourcePath = `${documentPath}/assets/label.js`;
  const publish = (text: string) => {
    canvasStore.writeSource(canvas.id, `<!-- @tailwind: standalone fixture -->
      <h1 id="document">${text}</h1><p id="asset"></p><script src="label.js"></script>`);
    expect(canvasStore.publishSource(canvas.id).error).toBeUndefined();
  };
  publish("First document");
  fs.writeFileSync(assetPath, 'document.getElementById("asset").textContent = "First asset";');
  const { app } = buildApp({ canvasStore, config: { agent: { compressionThresholdTokens: 100000 } } } as AppDeps);
  const requests: Array<{ path: string; condition: string | null; status: number; encoding: string | null }> = [];
  // Exercise the production routes, CORS and compression over real HTTP.
  // Browser request interception would disable its HTTP cache.
  const fixture = startWorkspaceFixture(undefined, undefined, async (request) => {
    const response = await app.fetch(request);
    requests.push({
      path: new URL(request.url).pathname, condition: request.headers.get("If-None-Match"),
      status: response.status, encoding: response.headers.get("Content-Encoding")
    });
    return response;
  });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const content = page.locator("iframe").contentFrame();
  const readContent = async (documentText: string, assetText: string) => {
    await content.locator("#document", { hasText: documentText }).waitFor();
    await content.locator("#asset", { hasText: assetText }).waitFor();
  };
  try {
    await page.goto(`${fixture.baseUrl}/canvas/${canvas.id}/embed`);
    await readContent("First document", "First asset");
    expect(requests.find((r) => r.path === documentPath)).toMatchObject({ status: 200, condition: null });
    expect(requests.find((r) => r.path === documentPath)!.encoding).not.toBeNull();
    expect(requests.find((r) => r.path === resourcePath)).toMatchObject({ status: 200, condition: null });

    requests.length = 0;
    await page.reload();
    await readContent("First document", "First asset");
    for (const resource of [documentPath, resourcePath]) {
      const request = requests.find((r) => r.path === resource)!;
      expect(request.status).toBe(304);
      expect(request.condition).toStartWith('W/"');
      expect(request.encoding).toBeNull();
    }

    fs.writeFileSync(assetPath, 'document.getElementById("asset").textContent = "Second asset";');
    requests.length = 0;
    await page.reload();
    await readContent("First document", "Second asset");
    expect(requests.find((r) => r.path === documentPath)).toMatchObject({ status: 304 });
    expect(requests.find((r) => r.path === resourcePath)).toMatchObject({ status: 200 });

    publish("Updated document");
    fs.writeFileSync(assetPath, 'document.getElementById("asset").textContent = "Updated asset";');
    requests.length = 0;
    await page.evaluate((canvasId) => window.dispatchEvent(new CustomEvent("mandate:canvas-updated", {
      detail: { canvasId, featureId: null }
    })), canvas.id);
    await readContent("Updated document", "Updated asset");
    for (const resource of [documentPath, resourcePath]) {
      expect(requests.find((r) => r.path === resource)).toMatchObject({ status: 200 });
    }

    requests.length = 0;
    await page.reload();
    await readContent("Updated document", "Updated asset");
    for (const resource of [documentPath, resourcePath]) {
      expect(requests.find((r) => r.path === resource)).toMatchObject({ status: 304 });
    }
  } finally {
    await browser.close();
    fixture.stop();
    env.cleanup();
  }
}, 20000);
