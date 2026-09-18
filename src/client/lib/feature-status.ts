import type { WorkItemDto } from "@shared/api/work-items";

export type PillTone = "red" | "review" | "green" | "blue" | "cyan" | "violet";

/** One pill only. Attention is the only thing that asks the user to act, so it
 *  wins over phase; phase shows when nothing is asked. Two badges of equal
 *  weight side by side was what made state and call-to-action indistinguishable.
 *
 *  Pure — no React — so the header module exports only a component. */
export function statusPillFor(item: WorkItemDto | null): { label: string; tone: PillTone } | null {
  if (!item) return null;
  if (item.needsUser === "input") return { label: "Needs input", tone: "red" };
  if (item.needsUser === "review") return { label: "Needs review", tone: "review" };
  switch (item.phase) {
    case "done": return { label: "Done", tone: "green" };
    case "working": return { label: "Working", tone: "blue" };
    case "verifying": return { label: "Verifying", tone: "cyan" };
    case "design": return { label: "Design", tone: "violet" };
  }
  return null;
}
