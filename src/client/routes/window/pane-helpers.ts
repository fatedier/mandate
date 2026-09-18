import type { SnapshotPane, WindowStatus } from "@/lib/snapshot-types";
import { getPaneDisplayCommand } from "@/lib/render";

export function paneStatus(pane: SnapshotPane): WindowStatus {
  return (pane.analysis?.status as WindowStatus | undefined) ?? "unknown";
}

/** The panel border tints only when the pane is waiting on the user; every
 *  other status is carried by the dot alone. */
export function statusBorderClass(pane: SnapshotPane): string {
  return paneStatus(pane) === "waiting_user" ? "border-status-input/40" : "";
}

export function paneTitle(pane: SnapshotPane): string {
  const name = pane.metadata?.name?.trim();
  if (name) return name;
  return getPaneDisplayCommand(pane) || "-";
}
