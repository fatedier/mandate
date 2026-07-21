import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";
import { attachPageDiagnostics } from "./helpers/page-diagnostics";

let fixture: ReturnType<typeof startWorkspaceFixture>;
let browser: Browser;
beforeAll(async () => {
  fixture = startWorkspaceFixture();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  fixture?.stop();
});

async function open(width = 1440, preferences: Record<string, unknown> = { chatPanelRatio: 0.5 }, openChat = true) {
  const page = await browser.newPage({ viewport: { width, height: 960 } });
  page.setDefaultTimeout(5000);
  attachPageDiagnostics(page);
  await page.addInitScript(({ preferences, openChat }) => {
    if (window.top !== window) return;
    if (!localStorage.getItem("ap.ui")) localStorage.setItem("ap.ui", JSON.stringify({
      state: { sidebarCollapsed: true, ...preferences }, version: 0
    }));
    if (!localStorage.getItem("mandate.chat.drawerOpen.v1")) {
      localStorage.setItem("mandate.chat.drawerOpen.v1", String(openChat));
    }
  }, { preferences, openChat });
  await page.goto(fixture.baseUrl + WORKER_PATH);
  await page.getByRole("heading", { name: "Worker pane zoom", exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector("main")!.scrollHeight > 3000);
  return page;
}
const mode = (page: Page) => page.locator("[data-pane-mode]").getAttribute("data-pane-mode");
const workerButton = (page: Page) => page.locator('[data-pane-zoom="worker"]');
const chatButton = (page: Page) => page.locator('[data-pane-zoom="chat"]');
const sizes = (page: Page) => page.evaluate(() => ({
  workspace: document.querySelector("[data-pane-mode]")!.getBoundingClientRect().width,
  worker: document.querySelector("main")!.getBoundingClientRect().width,
  chat: document.querySelector('[aria-label="Assistant dock"]')!.getBoundingClientRect().width
}));

for (const modifier of ["Control", "Meta"]) {
  test(`${modifier}+Shift+Enter never sends terminal input while toggling Worker zoom`, async () => {
    const page = await open();
    try {
      fixture.setTerminalPane(true);
      const inputs: string[] = [];
      let onInput = (_data: string) => {};
      // Real xterm + its production onData/WebSocket path, with no shell at
      // the other end. Resize frames are deliberately excluded from inputs.
      await page.routeWebSocket("**/api/terminal?*", (socket) => {
        socket.onMessage((raw) => {
          const message = JSON.parse(String(raw));
          if (message.type === "input") {
            inputs.push(message.data);
            onInput(message.data);
          }
        });
      });
      await page.goto(fixture.baseUrl + WORKER_PATH + "/pane/%250");
      const terminal = page.locator(".xterm-helper-textarea");
      await terminal.focus();
      const send = async (key: string, expected: string) => {
        const arrived = new Promise<void>((resolve) => { onInput = (data) => { if (data === expected) resolve(); }; });
        await page.keyboard.press(key);
        await arrived;
      };
      await send("p", "p");
      for (const expectedMode of ["worker", "split"]) {
        await page.keyboard.press(`${modifier}+Shift+Enter`);
        expect(await mode(page)).toBe(expectedMode);
        expect(await terminal.evaluate((el) => document.activeElement === el)).toBe(true);
        // A following input is a WebSocket delivery barrier as well as proof
        // that typing still reaches the focused terminal after layout changes.
        await send("x", "x");
        expect(inputs.join("")).not.toContain("\r");
      }
      await page.keyboard.down(modifier);
      await page.keyboard.down("Shift");
      await page.keyboard.down("Enter");
      await page.keyboard.down("Enter"); // auto-repeat must also be consumed
      await page.keyboard.up("Enter");
      await page.keyboard.up("Shift");
      await page.keyboard.up(modifier);
      expect(await mode(page)).toBe("worker");
      await send("x", "x");
      expect(inputs.join("")).toBe("pxxx");
      await send("Escape", "\u001b");
      expect(await mode(page)).toBe("worker");
      await send("Enter", "\r");
      expect(inputs.join("")).toBe("pxxx\u001b\r");
    } finally { fixture.setTerminalPane(false); await page.close(); }
  }, 20_000);
}

async function canvasEditor(page: Page) {
  const frame = page.locator("iframe").first().contentFrame();
  await frame.locator("body").evaluate((body) => {
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Canvas editor");
    body.prepend(input);
  });
  return { frame, input: frame.getByRole("textbox", { name: "Canvas editor" }) };
}

test("Canvas editor retains focus and accepts typing across Worker zoom and restore", async () => {
  const page = await open();
  try {
    const { input } = await canvasEditor(page);
    await input.fill("before");
    for (const shortcut of ["Meta+Shift+Enter", "Control+Shift+Enter"]) {
      await page.keyboard.press(shortcut);
      await page.waitForFunction(() => document.querySelector('[data-pane-mode="worker"]'));
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("IFRAME");
      await page.keyboard.type(" zoomed");
      expect(await input.inputValue()).toBe("before zoomed");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.querySelector('[data-pane-mode="split"]'));
      await page.keyboard.type(" restored");
      expect(await input.inputValue()).toBe("before zoomed restored");
      await input.fill("before");
    }
    // Returning from a hidden chat input must not steal focus after the user
    // deliberately moves into the visible Canvas while zoomed.
    await page.locator("textarea").fill("Chat draft");
    await page.keyboard.press("Meta+Shift+Enter");
    await input.fill("Now editing the Worker");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector('[data-pane-mode="split"]'));
    await page.keyboard.type(" here");
    expect(await input.inputValue()).toBe("Now editing the Worker here");
    expect(await page.locator("textarea").inputValue()).toBe("Chat draft");
  } finally { await page.close(); }
}, 20_000);

test("closed Canvas dialogs allow zoom and Escape, while open dialogs retain them", async () => {
  const page = await open();
  try {
    const { frame, input } = await canvasEditor(page);
    for (const kind of ["hidden", "display:none", "data-state=closed", "hidden ancestor", "visibility:hidden", "native closed"]) {
      await frame.locator("body").evaluate((body, kind) => {
        const wrapper = document.createElement("div");
        wrapper.id = "dialog-fixture";
        const dialog = document.createElement(kind === "native closed" ? "dialog" : "div");
        dialog.setAttribute("role", "dialog");
        dialog.textContent = "Closed dialog";
        if (kind === "hidden") dialog.hidden = true;
        if (kind === "display:none") dialog.style.display = "none";
        if (kind === "data-state=closed") dialog.dataset.state = "closed";
        if (kind === "hidden ancestor") wrapper.hidden = true;
        if (kind === "visibility:hidden") dialog.style.visibility = "hidden";
        wrapper.appendChild(dialog);
        body.appendChild(wrapper);
      }, kind);
      await input.focus();
      await page.keyboard.press("Meta+Shift+Enter");
      await page.waitForFunction(() => document.querySelector('[data-pane-mode="worker"]'), undefined, { timeout: 2000 });
      await input.focus();
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.querySelector('[data-pane-mode="split"]'), undefined, { timeout: 2000 });
      await frame.locator("#dialog-fixture").evaluate((el) => el.remove());
    }
    await workerButton(page).click();
    await frame.locator("body").evaluate((body) => {
      const dialog = document.createElement("dialog");
      dialog.textContent = "Open dialog";
      dialog.style.cssText = "position:fixed;inset:24px auto auto 24px;margin:0";
      body.appendChild(dialog);
      dialog.showModal();
    });
    await frame.getByText("Open dialog", { exact: true }).click();
    await page.keyboard.press("Escape");
    await frame.locator("dialog").waitFor({ state: "hidden" });
    await page.waitForTimeout(100);
    expect(await mode(page)).toBe("worker");
    await input.focus();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector('[data-pane-mode="split"]'));
  } finally { await page.close(); }
}, 20_000);

test("Canvas handlers can consume Escape before it reaches workspace zoom", async () => {
  const page = await open();
  try {
    const { frame, input } = await canvasEditor(page);
    for (const target of ["document", "window"]) {
      await workerButton(page).click();
      await input.focus();
      await frame.locator("body").evaluate((body, target) => {
        delete body.dataset.escapeHandled;
        const listenerTarget = target === "window" ? window : document;
        listenerTarget.addEventListener("keydown", (event) => {
          event.preventDefault();
          body.dataset.escapeHandled = String(event.defaultPrevented);
        }, { once: true });
      }, target);
      await page.keyboard.press("Escape");
      await frame.locator('body[data-escape-handled="true"]').waitFor();
      // Allow the iframe message task to arrive if the bridge incorrectly
      // sent Escape before the later-registered Canvas handler canceled it.
      await page.waitForTimeout(100);
      expect(await mode(page)).toBe("worker");
      await input.focus();
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.querySelector('[data-pane-mode="split"]'));
    }
  } finally { await page.close(); }
}, 20_000);

test("zoom restores the split, near-bottom Canvas reading position, draft and hidden live chat", async () => {
  const page = await open();
  try {
    const handle = page.getByRole("separator", { name: "Resize chat panel" });
    await handle.focus();
    await page.keyboard.press("ArrowLeft");
    const split = await sizes(page);
    expect(split.chat).toBeGreaterThan(split.worker);
    const input = page.locator("textarea");
    await input.fill("Preserve this draft");
    const inputNode = await input.elementHandle();
    const transcript = page.locator('[aria-label="Assistant dock"] div.overflow-y-auto');
    await page.getByText("Message 1.", { exact: false }).waitFor();
    await transcript.evaluate((el) => { el.scrollTop = 500; });
    await page.locator("main").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const readingPosition = await page.locator("main").evaluate((el) => el.scrollTop);
    await workerButton(page).click();
    expect(await mode(page)).toBe("worker");
    const zoomed = await sizes(page);
    expect(zoomed.worker).toBe(zoomed.workspace);
    expect(await inputNode!.evaluate((el) => el.isConnected && !!el.closest("[inert]"))).toBe(true);
    expect(await page.locator("iframe").first().evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(1120);
    await page.waitForFunction((top) => document.querySelector("main")!.scrollHeight - document.querySelector("main")!.clientHeight < top, readingPosition);
    fixture.appendMessage("Arrived while the Worker was zoomed");
    await page.getByText("Arrived while the Worker was zoomed", { exact: true }).waitFor({ state: "attached" });
    await workerButton(page).click();
    await page.waitForFunction((top) => Math.abs(document.querySelector("main")!.scrollTop - top) < 1, readingPosition);
    expect(await sizes(page)).toEqual(split);
    expect(await input.inputValue()).toBe("Preserve this draft");
    expect(await inputNode!.evaluate((el) => el.isConnected && !el.closest("[inert]"))).toBe(true);
    expect(await transcript.evaluate((el) => el.scrollTop)).toBe(500);
    await handle.dblclick();
    const equal = await sizes(page);
    expect(equal.worker).toBeCloseTo(equal.chat, 1);
    await page.reload();
    await workerButton(page).waitFor();
    expect(await mode(page)).toBe("split");
    const reloaded = await sizes(page);
    expect(reloaded.worker).toBeCloseTo(reloaded.chat, 1);
  } finally { await page.close(); }
}, 20_000);

test("Canvas artifact modal and pane zoom consume separate Esc presses, including inside an iframe", async () => {
  const page = await open();
  try {
    await workerButton(page).click();
    await page.getByRole("button", { name: "Artifacts", exact: true }).click();
    await page.getByRole("button", { name: "Open canvas: Workspace canvas", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Canvas", exact: true });
    await dialog.waitFor();
    await dialog.locator("iframe").contentFrame().getByRole("heading", { name: "Workspace canvas" }).click();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    expect(await mode(page)).toBe("worker");
    await page.keyboard.press("Escape");
    expect(await mode(page)).toBe("split");
    expect(new URL(page.url()).pathname).toBe(WORKER_PATH);
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.locator("iframe").first().contentFrame().getByRole("heading", { name: "Workspace canvas" }).click();
    await page.keyboard.press("Meta+Shift+Enter");
    await page.waitForFunction(() => document.querySelector('[data-pane-mode="worker"]'));
    await page.locator("iframe").first().contentFrame().getByRole("heading", { name: "Workspace canvas" }).click();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector('[data-pane-mode="split"]'));
  } finally { await page.close(); }
}, 20_000);

test("zoom keeps tabs, restores keyboard focus, and ends on Worker navigation", async () => {
  const page = await open();
  try {
    await page.locator("textarea").fill("Keyboard draft");
    await page.keyboard.press("Meta+Shift+Enter");
    expect(await mode(page)).toBe("worker");
    expect(await workerButton(page).evaluate((el) => document.activeElement === el)).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.locator("textarea").evaluate((el) => document.activeElement === el)).toBe(true);
    await workerButton(page).click();
    for (const tab of ["Changes", "Artifacts", "Terminal"]) {
      await page.getByRole("button", { name: tab, exact: true }).click();
      expect(await mode(page)).toBe("worker");
    }
    await page.evaluate(() => {
      const terminalInput = document.createElement("textarea");
      terminalInput.className = "xterm-helper-textarea";
      document.querySelector("main")!.appendChild(terminalInput);
      terminalInput.focus();
    });
    await page.keyboard.press("Escape");
    expect(await mode(page)).toBe("worker");
    await page.locator(".xterm-helper-textarea").evaluate((el) => el.remove());
    await workerButton(page).click();
    expect(new URL(page.url()).searchParams.get("tab")).toBe("terminal");
    await chatButton(page).click();
    expect(await mode(page)).toBe("chat");
    const chatSize = await chatButton(page).boundingBox();
    expect(chatSize!.width).toBe(32);
    await page.keyboard.press("Escape");
    expect(await mode(page)).toBe("split");
    expect(new URL(page.url()).pathname).toBe(WORKER_PATH);
    await workerButton(page).click();
    // Navigate in the existing router so this tests reset, not page reload.
    await page.getByRole("link", { name: "Zoom project", exact: true }).click();
    await page.waitForURL("**/projects");
    // React Router updates history before its transition commits the page.
    await workerButton(page).waitFor({ state: "detached" });
    expect(await mode(page)).toBe("split");
    expect(await workerButton(page).count()).toBe(0);
  } finally { await page.close(); }
}, 20_000);

test("missing ratios use an equal split and a closed dock survives Worker zoom", async () => {
  const page = await open(1440, { chatPanelWidth: 650 });
  try {
    const initial = await sizes(page);
    expect(initial.chat).toBeCloseTo(initial.workspace / 2, 1);
    await workerButton(page).click();
    await workerButton(page).click();
    expect((await sizes(page)).chat).toBe(initial.chat);
    await page.getByRole("button", { name: "Collapse chat dock", exact: true }).click();
    expect((await sizes(page)).chat).toBe(40);
    await workerButton(page).click();
    expect((await sizes(page)).worker).toBe((await sizes(page)).workspace);
    await workerButton(page).click();
    expect((await sizes(page)).chat).toBe(40);
    expect(await page.evaluate(() => localStorage.getItem("mandate.chat.drawerOpen.v1"))).toBe("false");
  } finally { await page.close(); }
}, 20_000);

test("wide-screen equal split and the mobile breakpoint retain usable layouts", async () => {
  const page = await open(1920);
  try {
    const initial = await sizes(page);
    expect(initial.chat).toBe(936);
    expect(initial.worker).toBeCloseTo(initial.chat, 1);
    await workerButton(page).click();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForFunction(() => document.querySelector('[data-pane-mode="split"]'));
    expect(await workerButton(page).count()).toBe(0);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await workerButton(page).waitFor();
    expect(await mode(page)).toBe("split");
    const restored = await sizes(page);
    expect(restored.chat).toBeCloseTo(restored.worker, 1);
  } finally { await page.close(); }
}, 20_000);
