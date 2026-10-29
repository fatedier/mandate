import type { Page } from "playwright";

/**
 * What scrolls the page sideways: a list of the scrollers that overflow, as
 * "<element> <scrollWidth>><clientWidth>" — empty when nothing does.
 *
 * html, body and #root all clip (globals.css: overflow hidden), so neither
 * documentElement.scrollWidth nor body.scrollWidth grows with anything the
 * app renders — a check written against them passes on every page forever.
 * The page's own scroller is `main` (AppShell), and a page can have scrollers
 * of its own inside it (Settings' pane): a vertical scroller computes
 * overflow-x to auto too, so content too wide for it scrolls that region
 * sideways. All of those count, and so do the scrollers of an open dialog: a
 * sheet portals outside `main` (the phone worker sheet's body is a vertical
 * scroller too), and body only for what grows it from outside #root. A
 * scroller meant to scroll sideways — a code block, a wide table, a row of
 * tabs: overflow-x-auto, scroll-x-quiet, scroll-x-edges — is not the page
 * scrolling and is not counted.
 */
export function pageOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const SIDEWAYS_BY_DESIGN = /(^|\s)(overflow-x-(auto|scroll)|scroll-x-[a-z]+)(\s|$)/;
    const describe = (el: Element) => {
      if (el === document.body) return "body";
      const slot = el.getAttribute("data-slot");
      return el.tagName.toLowerCase() + (slot ? `[data-slot=${slot}]` : "");
    };
    const overflowing: string[] = [];
    const check = (el: Element) => {
      if (el.scrollWidth - el.clientWidth >= 1) overflowing.push(`${describe(el)} ${el.scrollWidth}>${el.clientWidth}`);
    };
    check(document.body);
    const roots = [...document.querySelectorAll("main, [role=dialog]")];
    for (const el of roots.flatMap((root) => [root, ...root.querySelectorAll("*")])) {
      const overflowX = getComputedStyle(el).overflowX;
      if (overflowX !== "auto" && overflowX !== "scroll") continue;
      if (SIDEWAYS_BY_DESIGN.test(el.getAttribute("class") ?? "")) continue;
      if (el.getClientRects().length === 0) continue;
      check(el);
    }
    return overflowing;
  });
}
