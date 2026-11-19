import type { Locator, Page } from "playwright";

// What the background-tasks e2e files read of a conversation's background
// work: the strip over its composer and the Background tasks list (a sheet
// on a phone, a popover on a desktop).

export const strip = (page: Page) => page.locator('[data-slot="worker-strip"]');

export const tasksList = (page: Page, phone: boolean) =>
  page.locator(phone ? '[data-slot="background-tasks-sheet"]' : '[data-slot="background-tasks-popover"]');

/** The first match's text, or "" when there is none. */
export async function textOf(locator: Locator): Promise<string> {
  return (await locator.count()) > 0 ? ((await locator.first().textContent()) ?? "") : "";
}

export interface ListRow { section: string; name: string; line: string }

/** The open list's rows, by section: what each says, read in one go. */
export function listRows(list: Locator): Promise<ListRow[]> {
  return list.locator('[data-slot="background-task-row"]').evaluateAll((rows) => rows.map((row) => ({
    section: row.closest('[data-slot="background-tasks-section"]')?.getAttribute("data-section") ?? "",
    name: row.querySelector('[data-slot="background-task-name"]')?.textContent ?? "",
    line: row.querySelector('[data-slot="background-task-step"], [data-slot="background-task-outcome"]')?.textContent ?? ""
  })));
}

/** Buttons in the open sheet a finger cannot be sure of: under 44px either way. */
export function smallTargets(list: Locator): Promise<string[]> {
  return list.locator("button").evaluateAll((buttons) => buttons.flatMap((button) => {
    const box = button.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return [];
    if (Math.min(box.width, box.height) >= 44) return [];
    return [`${button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "button"} ${Math.round(box.width)}x${Math.round(box.height)}`];
  }));
}
