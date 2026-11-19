import type { ToolRunRow } from "../../src/client/routes/window/chat/tool-run-summary.js";

/** Readers of a tool call's details (ToolCallDetails), shared by the tests
 *  that render them. */

/** The section headings, in order. */
export const headings = (el: ParentNode) => [...el.querySelectorAll('[data-slot="detail-label"]')].map((h) => h.textContent);

/** The section a heading labels: the heading's row, then what it labels. */
export function section(el: ParentNode, label: string): HTMLElement {
  const heading = [...el.querySelectorAll('[data-slot="detail-label"]')].find((h) => h.textContent === label);
  if (!heading) throw new Error(`no section "${label}" in ${headings(el).join(", ")}`);
  return heading.parentElement!.parentElement!;
}

/** An element's classes; none for a missing one. */
export const classes = (el: Element | null) => (el?.className ?? "").split(/\s+/);

/** The argument names of a definition list, in order. */
export const dts = (el: ParentNode) => [...el.querySelectorAll("dt")].map((dt) => dt.textContent);

/** A finished call of `toolName`, id "t1". */
export const call = (toolName: string, args: unknown, result: ToolRunRow["result"]): ToolRunRow =>
  ({ call: { toolCallId: "t1", toolName, args }, result, isRunning: false });
