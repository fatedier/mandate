import { expect, test } from "bun:test";
import { startWorkspaceFixture, THREAD_ID } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";

// A tap on a row of the phone's drawer closes it and opens a page. The slide
// out runs off the page's thread; when it ends, the drawer leaves the page
// only once the page's script hears of it, and a heavy page (a long chat)
// keeps that script busy for a while. Meanwhile the screen shows the drawer
// as it stands when its slide ends: it must stand where the slide left it,
// out of view with its shade gone, not back where it was open.
const browser = browserForFile();

test("the phone drawer and its shade stay out of view once their slide out ends", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  try {
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}`);
    await page.getByRole("button", { name: "Open navigation" }).tap();
    const drawer = page.locator('[data-slot="sheet-content"]');
    await drawer.and(page.locator('[data-state="open"]')).waitFor();
    // How each stands the moment its slide out ends, before the page's own
    // handler (the drawer's, on the element itself) runs.
    await page.evaluate(() => {
      const w = window as unknown as { ends: Array<{ slot: string | null; left: number; opacity: string }> };
      w.ends = [];
      window.addEventListener("animationend", (event) => {
        const el = event.target as HTMLElement;
        const slot = el.getAttribute("data-slot");
        if (event.animationName !== "exit" || (slot !== "sheet-content" && slot !== "sheet-overlay")) return;
        w.ends.push({ slot, left: Math.round(el.getBoundingClientRect().left), opacity: getComputedStyle(el).opacity });
      }, true);
    });
    const width = Math.round((await drawer.boundingBox())!.width);
    await drawer.locator('a[href="/activity"]').first().tap();
    await page.waitForURL(`${fixture.baseUrl}/activity`);
    await drawer.waitFor({ state: "detached" });
    const ends = await page.evaluate(() => (window as unknown as { ends: Array<{ slot: string | null; left: number; opacity: string }> }).ends);
    expect(ends.sort((a, b) => String(a.slot).localeCompare(String(b.slot)))).toEqual([
      { slot: "sheet-content", left: -width, opacity: "1" },
      { slot: "sheet-overlay", left: 0, opacity: "0" }
    ]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20000);
