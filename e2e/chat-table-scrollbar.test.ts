import { expect, test } from "bun:test";
import type { Page } from "playwright";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";

// A wide chat table's bar is one a reader drags. Left to the browser, Chrome
// on macOS draws it bright while the pointer is on it or drags it; the app's
// own faint thumb holds at rest, a little brighter on hover, more while
// dragged. Shots need the bars drawn: Playwright hides them by default.
const browser = browserForFile({ ignoreDefaultArgs: ["--hide-scrollbars"] });

const TABLE = [
  "| Group | Fields | Set by | Trusted | Changes on retry | Example value | Since | Notes |",
  "|---|---|---|---|---|---|---|---|",
  "| Order `order` | `.order.id` `.order.customerId` `.order.currency` `.order.channel` | the shop | no | no | `ord_0000000001` | export 2.4 | A shop can send any of them again. |",
  "| Shipment `shipment` | `.shipment.carrier` `.shipment.parcel.id` `.shipment.warehouse` | packing | yes | yes | `carrier-main` | export 2.6 | Follows the parcel a reshipment moves to. |"
].join("\n");

/** The page's colour at a point, from a one-pixel shot read back through a canvas. */
async function colorAt(page: Page, x: number, y: number): Promise<number> {
  const shot = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  const [r, g, b] = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.drawImage(img, 0, 0);
    return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  }, shot.toString("base64"));
  return Math.round((r! + g! + b!) / 3);
}

/** White at `alpha` over the dark ground (#141416), as one grey level. */
const over = (alpha: number) => Math.round(21 + alpha * (255 - 21));

test("a wide chat table's bar is the app's faint thumb at rest, a little brighter on hover, more while dragged", async () => {
  const fixture = startWorkspaceFixture();
  fixture.appendMessage(TABLE);
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
  page.setDefaultTimeout(8000);
  try {
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}`);
    await page.getByRole("tab", { name: "Chat", exact: true }).first().click();
    const box = page.locator('[data-slot="table-scroll"]').first();
    await box.waitFor();
    await box.scrollIntoViewIfNeeded();
    const size = await box.evaluate((el: HTMLElement) => ({ scrolls: el.scrollWidth > el.clientWidth, bar: el.offsetHeight - el.clientHeight }));
    expect(size.scrolls).toBe(true);
    const rect = (await box.boundingBox())!;
    // The middle of the bar's height, a little into the thumb (at rest it starts at the left).
    const x = Math.round(rect.x + 40);
    const y = Math.round(rect.y + rect.height - 3);
    await page.mouse.move(rect.x + rect.width / 2, rect.y - 40);
    const rest = await colorAt(page, x, y);
    await page.mouse.move(x, y);
    const hover = await colorAt(page, x, y);
    await page.mouse.down();
    const dragged = await colorAt(page, x, y);
    await page.mouse.up();
    expect(size.bar).toBe(6);
    expect(Math.abs(rest - over(0.06))).toBeLessThanOrEqual(4);
    expect(Math.abs(hover - over(0.22))).toBeLessThanOrEqual(4);
    expect(Math.abs(dragged - over(0.30))).toBeLessThanOrEqual(4);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 30_000);

test("on a touch screen a chat table keeps the system's own bar", async () => {
  const fixture = startWorkspaceFixture();
  fixture.appendMessage(TABLE);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "dark" });
  page.setDefaultTimeout(8000);
  try {
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}`);
    await page.getByRole("tab", { name: "Chat", exact: true }).first().tap();
    const box = page.locator('[data-slot="table-scroll"]').first();
    await box.waitFor();
    expect(await box.evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe("thin");
  } finally {
    await page.close();
    fixture.stop();
  }
}, 30_000);
