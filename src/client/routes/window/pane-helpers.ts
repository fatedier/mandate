import type { SnapshotPane, WindowStatus } from "@/lib/snapshot-types";
import { getPaneDisplayCommand } from "@/lib/render";

export function paneStatusClass(pane: SnapshotPane): string {
  const status = pane.analysis?.status ?? "unknown";
  return `status-${status}`;
}

export function paneStatus(pane: SnapshotPane): WindowStatus {
  return (pane.analysis?.status as WindowStatus | undefined) ?? "unknown";
}

export function paneTitle(pane: SnapshotPane): string {
  const name = pane.metadata?.name?.trim();
  if (name) return name;
  return getPaneDisplayCommand(pane) || "-";
}
