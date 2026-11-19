import type { Locator, Page } from "playwright";

/** Every row Home's Waiting on you lists. Two or more reviews are one row
 *  that opens to them, so it is opened first when there is one. */
export async function everyWaitingRow(page: Page): Promise<Locator> {
  const fold = page.locator('section[aria-label="Waiting on you"] [data-slot="waiting-fold"][aria-expanded="false"]');
  if (await fold.count()) await fold.click();
  return page.locator('section[aria-label="Waiting on you"] [data-waiting]');
}
