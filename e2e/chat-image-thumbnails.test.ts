import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { browserForFile } from "./helpers/browser.js";
import { artifactDir } from "./helpers/diagnostics.js";
import { trackPageErrors } from "./helpers/page-diagnostics.js";

// A chat page carries no image bytes: the transcript draws thumbnails, fetched
// as they are drawn, and the viewer the original. Served by the real binary,
// whose image pipeline makes the thumbnails.
const browser = browserForFile();
let server: RunningServer;
let threadId = "";
let tall: Uint8Array;

beforeAll(async () => {
  const icon = new Uint8Array(fs.readFileSync("assets/pwa/icon-512.png"));
  tall = await new Bun.Image(icon).resize(1200, 4200).png().bytes();
  const base64 = Buffer.from(tall).toString("base64");
  server = await startServer({
    configured: true,
    seed: (dataDir) => {
      const store = new MandateStore(dataDir);
      try {
        const agent = new AgentStore(store.db);
        const thread = agent.latestManagerThread("Report page");
        threadId = thread.id;
        const image = { mediaType: "image/png", data: base64, sizeBytes: tall.length };
        agent.appendMessage({ threadId, role: "user", source: "user", content: { type: "text", text: "Check the report page.", attachments: [{ type: "image", id: "att_1", name: "pasted.png", ...image }] } });
        agent.appendMessage({ threadId, role: "assistant", source: "self", wakeId: "wake_1", content: { type: "assistant", text: "Looking at it.", toolCalls: [{ toolCallId: "call_1", toolName: "view_image", args: { path: "report.png" } }] } });
        agent.appendMessage({ threadId, role: "tool", source: "self", wakeId: "wake_1", content: { type: "tool_result", toolCallId: "call_1", toolName: "view_image", result: { type: "view_image_result", message: "Viewed image: report.png", image: { type: "image", id: "img_1", name: "report.png", displayPath: "report.png", ...image } } } });
        agent.appendMessage({ threadId, role: "assistant", source: "self", wakeId: "wake_1", content: { type: "assistant", text: "The table overflows on a phone." } });
      } finally {
        store.db.close();
      }
    }
  });
}, 60_000);
afterAll(() => server?.cleanup());

test("a chat with images loads without their bytes, draws thumbnails and opens the original", async () => {
  const dir = artifactDir("chat-image-thumbnails");
  for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
    const page = await browser.newPage({ viewport, ...(name === "phone" ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    page.setDefaultTimeout(10_000);
    const errors = trackPageErrors(page);
    try {
      await page.goto(`${server.baseUrl}/threads/${threadId}`);
      // The page the chat reads: the bytes stay on the server, the page names
      // where to fetch them.
      const read = await page.evaluate(async (id) => {
        const body = await (await fetch(`/api/agents/threads/${id}?limit=50`)).text();
        return { size: body.length, addressed: body.includes("/api/agents/messages/") };
      }, threadId);
      expect(read.size < 20_000).toBe(true);
      expect(read.addressed).toBe(true);

      const strip = page.locator('[data-slot="tool-run"] [data-slot="image-tiles"] img');
      await strip.first().waitFor();
      expect(await strip.count()).toBe(1);
      expect(await strip.getAttribute("src")).toContain("/images/img_1?size=thumb");
      expect(await page.evaluate(async (src) => (await fetch(src)).headers.get("content-type"), (await strip.getAttribute("src"))!)).toBe("image/webp");
      await page.waitForFunction(() => {
        const img = document.querySelector<HTMLImageElement>('[data-slot="tool-run"] [data-slot="image-tiles"] img');
        return Boolean(img?.complete && img.naturalWidth > 0);
      });
      expect(await strip.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(400);
      const attached = page.locator('[data-slot="user-bubble"] [data-slot="image-tiles"] img');
      await page.waitForFunction(() => {
        const img = document.querySelector<HTMLImageElement>('[data-slot="user-bubble"] [data-slot="image-tiles"] img');
        return Boolean(img?.complete && img.naturalWidth > 0);
      });
      expect(await attached.getAttribute("src")).toContain("/images/att_1?size=thumb");
      await page.screenshot({ path: path.join(dir, `${name}.png`) });

      await page.locator('[data-slot="tool-run"] [data-slot="image-open"]').click();
      await page.waitForFunction(() => {
        const img = document.querySelector<HTMLImageElement>('[role="dialog"] img');
        return Boolean(img?.complete && img.naturalWidth > 0);
      });
      expect(await page.locator('[role="dialog"] img').evaluate((img: HTMLImageElement) => [img.naturalWidth, img.getAttribute("src")]))
        .toEqual([1200, expect.stringMatching(/\/images\/img_1$/)]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }
}, 60_000);
