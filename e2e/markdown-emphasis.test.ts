import { expect, test } from "bun:test";
import type { Page } from "playwright";
import { startWorkspaceFixture, THREAD_ID } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { look } from "./helpers/page-diagnostics.js";

// What an agent wrote marks its key words with bold and its commands and
// paths with code; each takes a colour of its own, as a terminal's Markdown
// theme gives them, so they stand out of the prose. Inside a link they take
// the link's colour: the link is what they are there.
const browser = browserForFile();

const REPLY = [
  "The fix is in. **Ready to merge** once CI on the release branch is green.",
  "",
  "- Run `go test -race ./pkg/cache/...` before tagging.",
  "- The change is in [`expiry.go`](https://example.com/acmecorp/project-1/expiry.go), see [**the release notes**](https://example.com/notes)."
].join("\n");

/** The computed colours, as `rgb(...)`, of the reply's bold text, its inline
 *  code, its link, and the code and bold inside links. */
async function colours(page: Page) {
  return page.evaluate(() => {
    const strong = [...document.querySelectorAll('[data-slot="worker-panel"] strong')].find((el) => el.textContent === "Ready to merge");
    // The reply: the nearest box holding both its bold and its links.
    let reply: Element = strong ?? document.body;
    while (reply.parentElement && !reply.querySelector('a[href*="expiry.go"]')) reply = reply.parentElement;
    const colour = (el: Element | null | undefined) => (el ? getComputedStyle(el).color : "missing");
    const code = [...reply.querySelectorAll("code")].find((el) => !el.closest("a"));
    const link = [...reply.querySelectorAll("a")].find((el) => el.textContent?.includes("expiry.go"));
    return {
      theme: document.documentElement.getAttribute("data-theme"),
      strong: colour(strong),
      code: colour(code),
      link: colour(link),
      codeInLink: colour(link?.querySelector("code")),
      strongInLink: colour([...reply.querySelectorAll("a strong")][0])
    };
  });
}

test("bold and inline code in an agent's reply take colours of their own in both themes; inside a link, the link's", async () => {
  const fixture = startWorkspaceFixture();
  fixture.appendMessage(REPLY);
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: "light" });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  try {
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`);
    const panel = page.locator('[data-slot="worker-panel"]');
    await panel.getByRole("tab", { name: "Chat", exact: true }).click();
    await panel.locator("strong", { hasText: "Ready to merge" }).waitFor();
    const light = await colours(page);
    expect(light).toEqual({
      theme: "light",
      strong: "rgb(190, 24, 93)",
      code: "rgb(15, 118, 110)",
      link: light.link,
      codeInLink: light.link,
      strongInLink: light.link
    });
    expect([light.strong, light.code]).not.toContain(light.link);
    await look(panel.locator("p", { hasText: "Ready to merge" }).locator(".."), "light");

    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark");
    const dark = await colours(page);
    expect(dark).toEqual({
      theme: "dark",
      strong: "rgb(244, 114, 182)",
      code: "rgb(92, 200, 187)",
      link: dark.link,
      codeInLink: dark.link,
      strongInLink: dark.link
    });
    expect(dark.link).not.toBe(light.link);
    await look(panel.locator("p", { hasText: "Ready to merge" }).locator(".."), "dark");
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20_000);
