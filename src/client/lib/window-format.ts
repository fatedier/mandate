import type { SnapshotWindow } from "@/lib/snapshot-types";

export function formatWindowTitle(window: Pick<SnapshotWindow, "windowIndex" | "windowName">): string {
  const name = (window.windowName ?? "").trim();
  const index = window.windowIndex;
  if (typeof index === "number" && name) return `${index}: ${name}`;
  if (typeof index === "number") return `window ${index}`;
  if (name) return name;
  return "(unknown window)";
}
