import { expect, test } from "bun:test";
import path from "node:path";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";
import { artifactDir } from "./helpers/diagnostics";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

/**
 * A worker's page on a phone: the top bar carries its name, its
 * state and its menu, as a phone's thread page does — not a breadcrumb over an
 * in-page row that named the worker a second time. A long name truncates and
 * leaves the menu at the bar's end.
 */

const browser = browserForFile();
const LONG = "Research project-1 Issue #39: the project-2 cache is not cleared after a config reload and the page keeps its old value";

// In light only: what is measured here is layout, the same in either scheme.
for (const [label, title] of [["short name", null], ["long name", LONG]] as const) {
  test(`a phone's worker page names the worker once, in the top bar (${label}, light)`, async () => {
    const fixture = startWorkspaceFixture();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "light" });
    page.setDefaultTimeout(8000);
    const errors = trackPageErrors(page);
    try {
      if (title) {
        await page.route("**/api/work-items**", async (route) => {
          const answer = await (await route.fetch()).json() as { items: Array<{ title: string }> };
          await route.fulfill({ json: { ...answer, items: answer.items.map((item) => ({ ...item, title })) } });
        });
      }
      await page.goto(`${fixture.baseUrl}${WORKER_PATH}?tab=plan`);
      const bar = page.locator("header").first();
      const name = bar.locator('[data-slot="feature-title"]');
      await name.waitFor();
      expect(await name.textContent()).toBe(title ?? "Worker pane zoom");
      expect(await page.locator('[data-slot="feature-title"]').count()).toBe(1);
      expect(await bar.locator('nav[aria-label="Breadcrumb"]').count()).toBe(0);
      expect(await bar.locator('[data-slot="feature-status"]').isVisible()).toBe(true);
      // The menu ends the bar, inside the screen, however long the name.
      const menu = (await bar.getByRole("button", { name: "Worker actions" }).boundingBox())!;
      expect(menu.x + menu.width).toBeLessThanOrEqual(390);
      const pill = (await bar.locator('[data-slot="feature-status"]').boundingBox())!;
      expect(pill.x + pill.width).toBeLessThanOrEqual(menu.x);
      await page.screenshot({ path: path.join(artifactDir("worker-page-phone-header"), `${label.replace(" ", "-")}-light.png`) });
      expect(errors).toEqual([]);
    } finally {
      await page.close();
      fixture.stop();
    }
  }, 20_000);
}
