import { expect, test } from "bun:test";
import type { BrowserContextOptions } from "playwright";
import { startWorkspaceFixture, THREAD_ID, WORKER_PATH } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

// The terminal page is titled by whose terminal it is, never by tmux's global
// pane id (%0 says nothing to a person). Desktop: "<worker or
// window> / Terminal" in the pane header, the name linking back. (Phone: the
// breadcrumb ends in Terminal, tested with the breadcrumb itself.) Which pane
// stays in the terminal's own bar.
const browser = browserForFile();

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 600 } };

/** Opens a terminal route; `live: false` opens one whose pane is gone. */
async function openPane(options: BrowserContextOptions, url: string, live = true) {
  const fixture = startWorkspaceFixture();
  fixture.setTerminalPane(live, "zsh");
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = trackPageErrors(page);
  await page.routeWebSocket("**/api/terminal?*", (socket) => { socket.send("user@mac zoom % "); });
  await page.goto(fixture.baseUrl + url);
  // The page is up: its terminal drew the screen it was sent, or it says the
  // pane is gone.
  if (live) await page.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").includes("user@mac"));
  else await page.getByText("Pane not found").waitFor();
  const close = async () => { try { await context.close(); } finally { fixture.stop(); } };
  return { page, errors, close };
}

// A worker's name leads back to its Terminal tab in its thread's panel, once
// the projects say which thread; with the pane gone too.
for (const { route, url, live, name, back } of [
  { route: "a worker's pane", url: `${WORKER_PATH}/pane/%250`, live: true, name: "zoom-worker", back: `/threads/${THREAD_ID}?worker=zoom-worker&tab=terminal` },
  { route: "a worker's pane that is gone", url: `${WORKER_PATH}/pane/%250`, live: false, name: "zoom-worker", back: `/threads/${THREAD_ID}?worker=zoom-worker&tab=terminal` }
]) {
  test(`desktop: ${route} is titled "${name} / Terminal", the name linking back`, async () => {
    const { page, errors, close } = await openPane(desktop, url, live);
    try {
      const header = page.locator('[data-slot="pane-header"]');
      const title = header.locator("h1");
      await title.filter({ hasText: "Terminal" }).waitFor();
      // The worker's name lands once the projects say whose pane it is.
      await title.getByRole("link", { name, exact: true }).waitFor();
      await title.locator(`a[href="${back}"]`).waitFor();
      expect((await title.innerText()).replace(/\s+/g, " ").trim()).toBe(`${name} / Terminal`);
      expect(await title.getByRole("link", { name, exact: true }).getAttribute("href")).toBe(back);
      expect(await header.innerText()).not.toContain("%0");
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 20_000);
}

test("a Terminals pane whose lookup gets no answer says it couldn't load, not that it is gone; Retry finds it", async () => {
  // A failed request used to read "Pane no longer exists".
  const fixture = startWorkspaceFixture();
  fixture.setTerminalPane(true, "zsh");
  const context = await browser.newContext(desktop);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = trackPageErrors(page);
  try {
    await page.routeWebSocket("**/api/terminal?*", (socket) => { socket.send("user@mac zoom % "); });
    await page.route("**/api/panes/**", (route) => route.abort("failed"));
    await page.goto(fixture.baseUrl + "/terminals/pane/%250");
    const state = page.locator('[data-slot="state-message"]');
    await state.getByRole("heading", { name: "Couldn't load this pane", exact: true }).waitFor();
    expect(await state.innerText()).not.toContain("not found");
    await page.unroute("**/api/panes/**");
    // The lookup also re-reads every 3s, which would find the pane on its own:
    // it is Retry that asks again at once.
    const lookups: number[] = [];
    page.on("request", (request) => { if (request.url().includes("/api/panes/")) lookups.push(Date.now()); });
    const clickedAt = Date.now();
    await state.getByRole("button", { name: "Retry", exact: true }).click();
    await page.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").includes("user@mac"));
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups[0]! - clickedAt).toBeLessThan(1000);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20_000);
