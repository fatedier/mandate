import { expect, test } from "bun:test";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

const browser = browserForFile();

const html = `<style>body{font:16px system-ui;padding:16px}</style>
  <label>Draft <input id="draft" /></label>`;

async function open(tab: string) {
  const fixture = startWorkspaceFixture();
  fixture.setCanvasHtml(html);
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(5000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(fixture.baseUrl + WORKER_PATH + `?tab=${tab}`);
    await page.locator("main").getByRole("tab", { name: "Plan", exact: true }).waitFor();
  } catch (error) {
    await page.close();
    fixture.stop();
    throw error;
  }
  return { fixture, page, errors, close: async () => { await page.close(); fixture.stop(); } };
}

// Opening a report and rendering /canvas/:id are canvas-requests' and
// canvas-report's. What is left here is the gallery's absence, on the pages
// that once linked to it.
test("there is no global Canvas gallery: no link to one, and its old route lands on Home", async () => {
  const env = await open("reports");
  try {
    await env.page.getByRole("button", { name: /^Open report: / }).waitFor();
    expect(await env.page.locator('a[href="/canvas"]').count()).toBe(0);
    await env.page.goto(`${env.fixture.baseUrl}/canvas/zoom-canvas`);
    await env.page.locator("main iframe").contentFrame().locator("#draft").waitFor();
    expect(await env.page.locator('a[href="/canvas"]').count()).toBe(0);
    await env.page.goto(`${env.fixture.baseUrl}/canvas`);
    await env.page.waitForURL(`${env.fixture.baseUrl}/home`);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 15000);

async function openModal(env: Awaited<ReturnType<typeof open>>) {
  await env.page.getByRole("button", { name: /^Open report: / }).click();
  const modal = env.page.getByRole("dialog", { name: "Canvas", exact: true });
  const frame = modal.locator("iframe").contentFrame();
  await frame.locator("#draft").waitFor();
  return { modal, frame };
}

test("inside the Canvas modal, a closed dialog lets Escape close the modal and an open one keeps it", async () => {
  const env = await open("reports");
  try {
    for (const kind of ["hidden", "display:none", "data-state=closed", "hidden ancestor", "visibility:hidden", "native closed"]) {
      const { modal, frame } = await openModal(env);
      await frame.locator("body").evaluate((body, kind) => {
        const wrapper = document.createElement("div");
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
      await frame.locator("#draft").focus();
      await env.page.keyboard.press("Escape");
      await modal.waitFor({ state: "detached", timeout: 2000 });
    }

    const { modal, frame } = await openModal(env);
    await frame.locator("body").evaluate((body) => {
      const dialog = document.createElement("dialog");
      dialog.textContent = "Open dialog";
      body.appendChild(dialog);
      dialog.showModal();
    });
    await frame.getByText("Open dialog", { exact: true }).click();
    await env.page.keyboard.press("Escape");
    await frame.locator("dialog").waitFor({ state: "hidden" });
    // Let a wrongly forwarded Escape arrive before asserting the modal stayed.
    await env.page.waitForTimeout(100);
    expect(await modal.isVisible()).toBe(true);
    await frame.locator("#draft").focus();
    await env.page.keyboard.press("Escape");
    await modal.waitFor({ state: "detached" });
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 30000);

test("a Canvas handler can consume Escape before it closes the modal", async () => {
  const env = await open("reports");
  try {
    for (const target of ["document", "window"]) {
      const { modal, frame } = await openModal(env);
      await frame.locator("#draft").focus();
      await frame.locator("body").evaluate((body, target) => {
        delete body.dataset.escapeHandled;
        (target === "window" ? window : document).addEventListener("keydown", (event) => {
          event.preventDefault();
          body.dataset.escapeHandled = String(event.defaultPrevented);
        }, { once: true });
      }, target);
      await env.page.keyboard.press("Escape");
      await frame.locator('body[data-escape-handled="true"]').waitFor();
      // Let a wrongly forwarded Escape arrive before asserting the modal stayed.
      await env.page.waitForTimeout(100);
      expect(await modal.isVisible()).toBe(true);
      await frame.locator("#draft").focus();
      await env.page.keyboard.press("Escape");
      await modal.waitFor({ state: "detached" });
    }
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 20000);
