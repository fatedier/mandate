import { expect, test } from "bun:test";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";
import { trackRequests } from "./helpers/settle";
import { startWorkspaceFixture, THREAD_ID, WORKER_PATH } from "./helpers/workspace-fixture";

// The shared e2e harness: what it promises every file that uses it.
const browser = browserForFile();

test("browserForFile hands the file a launched browser to open pages with", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent("<p id=here>here</p>");
    expect(await page.locator("#here").textContent()).toBe("here");
    expect(browser.isConnected()).toBe(true);
  } finally {
    await page.close();
  }
});

test("trackPageErrors collects an uncaught exception, and only those", async () => {
  const page = await browser.newPage();
  const errors = trackPageErrors(page);
  try {
    await page.setContent("<p>quiet</p>");
    expect(errors).toEqual([]);
    await page.evaluate(() => { setTimeout(() => { throw new Error("render failed"); }, 0); });
    await page.waitForTimeout(50);
    expect(errors).toEqual(["render failed"]);
  } finally {
    await page.close();
  }
});

// A request the fixture refuses is an error on the page that made it, and a
// page that saw an error keeps a frame and its DOM when it closes
// (page-diagnostics): on every test, passing or not.
test("the workspace fixture answers every request its pages make: a thread's page, and a worker's chat", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  const refused: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400) refused.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
  });
  const requests = await trackRequests(page);
  try {
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}`);
    await page.getByPlaceholder("Message the manager…").waitFor();
    await requests.idle();
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}`);
    await page.getByRole("tab", { name: "Chat", exact: true }).first().click();
    await page.getByPlaceholder("Message the worker…").waitFor();
    await requests.idle();
    expect(refused).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 30_000);
