import type { Page } from "playwright";

/** Keeps every close watcher the page makes, so a test can send the one the
 *  page holds a close request, as the phone's Back does. The browser's own
 *  CloseWatcher underneath: only the construction is noted. */
export async function recordCloseWatchers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Native = (window as unknown as { CloseWatcher?: new () => EventTarget }).CloseWatcher;
    if (!Native) return;
    const made: EventTarget[] = [];
    (window as unknown as { __closeWatchers: EventTarget[] }).__closeWatchers = made;
    (window as unknown as { CloseWatcher: unknown }).CloseWatcher = class extends Native {
      constructor() {
        super();
        made.push(this);
      }
    };
  });
}

/** The phone's Back: a close request to the newest watcher. Says whether the
 *  browser has CloseWatcher at all. */
export async function pressBack(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const made = (window as unknown as { __closeWatchers?: Array<{ requestClose(): void }> }).__closeWatchers;
    if (!made) return false;
    made.at(-1)?.requestClose();
    return true;
  });
}
