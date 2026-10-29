import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page, WebSocketRoute } from "playwright";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";
import { attachPageDiagnostics } from "./helpers/page-diagnostics";
import { browserForFile } from "./helpers/browser";
import { waitUntil } from "../tests/helpers/wait";

// Real xterm and the production hook, with the test standing in for the
// server end of /api/terminal: it decides what each connection draws and how
// each one ends.

let fixture: ReturnType<typeof startWorkspaceFixture>;
const browser = browserForFile();
beforeAll(() => {
  fixture = startWorkspaceFixture();
  fixture.setTerminalPane(true);
});
afterAll(() => {
  fixture?.stop();
});

async function openTerminal(onConnect: (socket: WebSocketRoute, index: number) => void) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(5000);
  attachPageDiagnostics(page);
  const sockets: WebSocketRoute[] = [];
  const connectedAt: number[] = [];
  const inputs: Array<{ socket: number; data: string }> = [];
  await page.routeWebSocket("**/api/terminal?*", (socket) => {
    const index = sockets.push(socket) - 1;
    connectedAt.push(Date.now());
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "input") inputs.push({ socket: index, data: message.data });
    });
    onConnect(socket, index);
  });
  await page.goto(fixture.baseUrl + WORKER_PATH + "/pane/%250");
  return { page, sockets, connectedAt, inputs };
}

const screenText = (page: Page) =>
  page.locator(".xterm-rows").evaluate((el) => el.textContent ?? "");
const waitForScreen = (page: Page, text: string) =>
  page.waitForFunction((t) => (document.querySelector(".xterm-rows")?.textContent ?? "").includes(t), text);
const connected = (page: Page) => page.locator('[aria-label="connected"]').first().waitFor();
const statusPill = (page: Page, status: string) =>
  page.getByText(status, { exact: true }).first().waitFor();

test("a dropped terminal reconnects, and the new capture replaces the old screen", async () => {
  const { page, sockets, inputs } = await openTerminal((socket, index) => {
    socket.send(index === 0 ? "first-screen" : "second-screen");
  });
  try {
    await waitForScreen(page, "first-screen");
    await connected(page);

    sockets[0]!.close({ code: 1011, reason: "attach failed" });
    await statusPill(page, "reconnecting");
    await waitForScreen(page, "second-screen");
    await connected(page);

    expect(sockets).toHaveLength(2);
    // Reset before the new capture: the old screen is gone, not scrolled up.
    const text = await screenText(page);
    expect([text.includes("second-screen"), text.includes("first-screen")]).toEqual([true, false]);

    // Typing reaches the new socket.
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("x");
    await waitUntil(() => inputs.some((i) => i.data === "x"), { timeout: 3000, label: () => `the typed key to reach a socket (inputs: ${JSON.stringify(inputs)})` });
    expect(inputs).toEqual([{ socket: 1, data: "x" }]);
  } finally {
    await page.close();
  }
});

test("the app's event stream reopening skips the rest of the backoff", async () => {
  // Connections 1-3 fail before sending anything, so the backoff grows to 4 s
  // after the fourth close; the reopen event must beat it.
  const { page, sockets, connectedAt } = await openTerminal((socket, index) => {
    if (index === 0) socket.send("first-screen");
    else if (index <= 3) socket.close({ code: 1011, reason: "attach failed" });
    else socket.send("back");
  });
  try {
    await waitForScreen(page, "first-screen");
    sockets[0]!.close({ code: 1011, reason: "attach failed" });
    await waitUntil(() => sockets.length >= 4, { timeout: 10_000, label: () => `the fourth terminal connection (${sockets.length} so far)` });
    expect(sockets).toHaveLength(4);
    // Let the fourth close land and the 4 s wait begin.
    await Bun.sleep(200);
    const dispatchedAt = Date.now();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("mandate:sse-open")));
    await waitForScreen(page, "back");
    expect(sockets).toHaveLength(5);
    expect(connectedAt[4]! - dispatchedAt).toBeLessThan(2000);
  } finally {
    await page.close();
  }
});
