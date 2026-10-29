import { expect, test } from "bun:test";
import type { BrowserContextOptions } from "playwright";
import { startWorkspaceFixture } from "./helpers/workspace-fixture";
import { settle } from "./helpers/settle";
import { browserForFile } from "./helpers/browser";

// New thread is the nav's first row and looks like every other row: on the
// desktop sidebar (expanded or collapsed) and in the phone's drawer its icon
// and label line up with the rows under it, at their size, weight and colour,
// and it is filled the same way when its page (Home) is the current one. Its
// place and its pencil mark it.
const browser = browserForFile();

const PHONE: BrowserContextOptions = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true };
const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };

/** Each row's icon left, label left, font size, height, and its look:
 *  weight, colour, fill. */
const rows = () => [...document.querySelectorAll<HTMLAnchorElement>('[data-slot="new-thread"], nav a[href^="/projects"], nav a[href^="/memory"]')]
  .filter((a) => a.getBoundingClientRect().width > 0)
  .map((a) => {
    const label = [...a.querySelectorAll("*"), a].flatMap((el) => [...el.childNodes]).find((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())!;
    const range = document.createRange();
    range.selectNodeContents(label);
    return {
      name: label.textContent!.trim(),
      icon: Math.round(a.querySelector("svg")!.getBoundingClientRect().left),
      text: Math.round(range.getBoundingClientRect().left),
      font: getComputedStyle(label.parentElement!).fontSize,
      height: Math.round(a.getBoundingClientRect().height),
      weight: getComputedStyle(a).fontWeight,
      color: getComputedStyle(a).color,
      fill: getComputedStyle(a).backgroundColor,
      current: a.getAttribute("aria-current") === "page"
    };
  });

for (const [where, device] of [["the phone's drawer", PHONE], ["the desktop sidebar", DESKTOP]] as const) {
  test(`in ${where} New thread lines up with the rows under it`, async () => {
    const fixture = startWorkspaceFixture();
    const context = await browser.newContext(device);
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      await page.goto(`${fixture.baseUrl}/projects`);
      if (device === PHONE) await page.getByRole("button", { name: "Open navigation" }).tap();
      await page.locator('[data-slot="new-thread"]').first().waitFor();
      await settle(page);
      const [first, ...rest] = await page.evaluate(rows);
      expect(first!.name).toBe("New thread");
      expect(rest.length).toBeGreaterThan(0);
      for (const row of rest) {
        expect({ icon: first!.icon, text: first!.text, font: first!.font, height: first!.height, weight: first!.weight })
          .toEqual({ icon: row.icon, text: row.text, font: row.font, height: row.height, weight: row.weight });
      }
      // On Projects: New thread rests like Memory; Projects is the current one.
      const resting = rest.find((row) => !row.current)!;
      const current = rest.find((row) => row.current)!;
      expect({ color: first!.color, fill: first!.fill }).toEqual({ color: resting.color, fill: resting.fill });
      // On Home, New thread is the current one, filled as Projects was.
      await page.goto(`${fixture.baseUrl}/home`);
      if (device === PHONE) await page.getByRole("button", { name: "Open navigation" }).tap();
      await page.locator('[data-slot="new-thread"][aria-current="page"]').first().waitFor();
      await settle(page);
      const [home] = await page.evaluate(rows);
      expect({ color: home!.color, fill: home!.fill }).toEqual({ color: current.color, fill: current.fill });
    } finally {
      await context.close();
      fixture.stop();
    }
  }, 30_000);
}

test("in the collapsed desktop sidebar New thread's icon rests like the others", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext(DESKTOP);
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(`${fixture.baseUrl}/projects`);
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await page.locator('[data-slot="new-thread"][aria-label="New thread"]').waitFor();
    const colors = await page.evaluate(() => {
      const icon = (selector: string) => getComputedStyle(document.querySelector(selector)!).color;
      return { newThread: icon('[data-slot="new-thread"]'), memory: icon('nav a[aria-label="Memory"]') };
    });
    expect(colors.newThread).toBe(colors.memory);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);
