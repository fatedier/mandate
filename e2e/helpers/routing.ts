import type { Locator, Page } from "playwright";

/** Settings › Routing: a lane's row opened, as a click on it does. One row
 *  is open at a time, so opening one closes the one that was. */
export async function openLane(page: Page, route: string): Promise<void> {
  const toggle = page.locator(`[data-route="${route}"] [data-slot="section-header"] button[aria-expanded]`);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page.locator(`[data-route="${route}"] [data-slot="section-header"] button[aria-expanded="true"]`).waitFor();
  // And still: the row grows open, moving what it holds, and a pointer set
  // down on it before that ends finds the hover gone once it has.
  await page.waitForFunction((lane) => {
    const fold = document.querySelector(`[data-route="${lane}"] [data-slot="fold"]`);
    return fold !== null && fold.getAnimations().length === 0;
  }, route);
}

/** What a lane's row says it runs, open or not. */
export function laneSummary(page: Page, route: string): Locator {
  return page.locator(`[data-route="${route}"] [data-slot="section-summary"]`);
}
