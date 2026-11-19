import { expect, test } from "bun:test";
import type { Page } from "playwright";
import { startWorkspaceFixture, THREAD_ID } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { look, trackPageErrors } from "./helpers/page-diagnostics";

// What a link opens shows on it, and nothing underlines it at rest: a report
// (a canvas) and a file after an icon, a web page with a small arrow after
// it; the underline comes under the pointer. A bare address in Chinese text
// ends where the address does.
const browser = browserForFile();

const REPLY = [
  "**[#34](https://example.com/library/books/34) 已上架。** 编目已核对，完整结论见 [上架前检查](/canvas/zoom-canvas)。",
  "",
  "- catalogue：https://example.com/library/lists/1001（success，编号 `lists/1001/head`）",
  "- 日志在 [verify.log](file:///tmp/verify.log)。"
].join("\n");

/** Each link of the reply: its words, its mark, its underline, and where it goes. */
async function links(page: Page) {
  return page.evaluate(() => {
    const reply = [...document.querySelectorAll('[data-slot="worker-panel"] p, [data-slot="worker-panel"] li')].filter((el) => /已上架|catalogue|日志在/.test(el.textContent ?? ""));
    return reply.flatMap((el) => [...el.querySelectorAll("a")]).map((a) => ({
      words: a.textContent,
      mark: a.querySelector('[data-slot="canvas-link-icon"]') ? "canvas" : a.querySelector('[data-slot="file-link-icon"]') ? "file" : a.querySelector('[data-slot="external-link-icon"]') ? "web" : "-",
      underline: getComputedStyle(a).textDecorationLine,
      href: a.getAttribute("href")
    }));
  });
}

test("links say what they open and are underlined only under the pointer; a bare address stops at Chinese punctuation", async () => {
  const fixture = startWorkspaceFixture();
  fixture.appendMessage(REPLY);
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: "light" });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`);
    const panel = page.locator('[data-slot="worker-panel"]');
    await panel.getByRole("tab", { name: "Chat", exact: true }).click();
    await panel.locator("li", { hasText: "catalogue" }).waitFor();
    await page.mouse.move(5, 5);
    expect(await links(page)).toEqual([
      { words: "#34", mark: "web", underline: "none", href: "https://example.com/library/books/34" },
      { words: "上架前检查", mark: "canvas", underline: "none", href: "/canvas/zoom-canvas" },
      { words: "https://example.com/library/lists/1001", mark: "web", underline: "none", href: "https://example.com/library/lists/1001" },
      { words: "verify.log", mark: "file", underline: "none", href: expect.any(String) as unknown as string }
    ]);
    const reply = panel.locator("li", { hasText: "catalogue" }).locator("..").locator("..");
    await look(reply, "light");
    await panel.getByRole("link", { name: "#34" }).hover();
    expect(await panel.getByRole("link", { name: "#34" }).evaluate((a) => getComputedStyle(a).textDecorationLine)).toBe("underline");
    await page.mouse.move(5, 5);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark");
    await look(reply, "dark");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);

test("on a phone the same marks show, with nothing underlined", async () => {
  const fixture = startWorkspaceFixture();
  fixture.appendMessage(REPLY);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker&tab=chat`);
    const sheet = page.locator('[data-slot="worker-sheet"]');
    await sheet.locator("li", { hasText: "catalogue" }).waitFor();
    const marks = await sheet.locator("li a, p a").evaluateAll((all) => all.filter((a) => /#34|上架前检查|library\/lists|verify/.test(a.textContent ?? "")).map((a) => [
      a.querySelector('[data-slot="canvas-link-icon"]') ? "canvas" : a.querySelector('[data-slot="file-link-icon"]') ? "file" : a.querySelector('[data-slot="external-link-icon"]') ? "web" : "-",
      getComputedStyle(a).textDecorationLine
    ]));
    expect(marks).toEqual([["web", "none"], ["canvas", "none"], ["web", "none"], ["file", "none"]]);
    await look(page, "phone");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);
