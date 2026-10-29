import { afterAll, beforeAll } from "bun:test";
import { chromium, type Browser, type LaunchOptions } from "playwright";

/**
 * The file's browser: launched in a beforeAll, closed in an afterAll, so a
 * test file no longer carries its own launch and teardown. Call it once, at
 * the top level of the file. Options are chromium.launch's, for a file that
 * needs classic scrollbars or fake media devices.
 *
 * What it returns forwards every method and property to the launched
 * browser (`browser.newPage(...)`, `browser.newContext(...)`), but it is a
 * stand-in, not that object: `context.browser()` and the browser's own
 * methods hand back the real one, so compare those to each other, never to
 * this. No test here compares browsers.
 *
 * Assert on a page's value with `expect(await promise)`, not `.resolves`:
 * Bun's `.resolves` runs the event loop inside the matcher, and Playwright's
 * messages then arrive out of order ("… was not bound in the connection").
 */
export function browserForFile(options?: LaunchOptions): Browser {
  let browser: Browser | undefined;
  beforeAll(async () => { browser = await chromium.launch(options); }, 60_000);
  afterAll(async () => {
    await browser?.close();
    browser = undefined;
  });
  return new Proxy({} as Browser, {
    get(_target, key) {
      if (!browser) throw new Error("browserForFile: used outside the file's tests (before beforeAll launched it, or after afterAll closed it)");
      const value: unknown = Reflect.get(browser, key, browser);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(browser) : value;
    }
  });
}
