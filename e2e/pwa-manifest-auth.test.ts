import { expect, test } from "bun:test";
import { startWorkspaceFixture } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";

// Behind HTTP Basic auth (a reverse proxy in front, say), Chrome still reads
// the manifest: a manifest is fetched without credentials unless its link says
// crossorigin="use-credentials" (MDN, Web app manifests), and without it the
// 401 left Chrome with no name or icon: it refused to install, with a letter
// tile.
const browser = browserForFile();

test("behind Basic auth the page's manifest is still read", async () => {
  const fixture = startWorkspaceFixture();
  const expected = `Basic ${btoa("mandate:secret")}`;
  // Every request needs the password, as HTTP Basic auth in front of the app does.
  const proxy = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.headers.get("authorization") !== expected) {
        return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": 'Basic realm="Restricted"' } });
      }
      const url = new URL(request.url);
      return fetch(`${fixture.baseUrl}${url.pathname}${url.search}`, { headers: request.headers });
    }
  });
  const context = await browser.newContext({ httpCredentials: { username: "mandate", password: "secret" } });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(`http://127.0.0.1:${proxy.port}/home`);
    await page.locator('[data-slot="new-thread"]').first().waitFor();
    const cdp = await context.newCDPSession(page);
    const manifest = await cdp.send("Page.getAppManifest");
    const parsed = manifest.data ? JSON.parse(manifest.data) as { name?: string } : {};
    expect({ errors: manifest.errors, name: parsed.name }).toEqual({ errors: [], name: "Mandate" });
  } finally {
    await context.close();
    proxy.stop(true);
    fixture.stop();
  }
}, 30_000);
