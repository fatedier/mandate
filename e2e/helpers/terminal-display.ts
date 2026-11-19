import type { Page } from "playwright";

/** The page's terminals at their pane's own size (Display "Pane's size"),
 *  kept with whatever else the page's UI store holds: for a test of what a
 *  terminal does at the size its pane has, not of Display. */
export async function terminalsAtPaneSize(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let saved: { state?: Record<string, unknown>; version?: number } = {};
    try { saved = JSON.parse(localStorage.getItem("mandate.ui") ?? "{}") as typeof saved; } catch { /* a fresh store */ }
    localStorage.setItem("mandate.ui", JSON.stringify({ ...saved, state: { ...saved.state, terminalDisplay: "pane" }, version: saved.version ?? 0 }));
  });
}
