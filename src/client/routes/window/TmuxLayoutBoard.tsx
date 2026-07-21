import { useMemo } from "react";
import { parseTmuxLayout } from "@/lib/tmux";
import { LayoutPane } from "@/routes/window/LayoutPane";
import type { SnapshotPane, SnapshotWindow } from "@/lib/snapshot-types";

interface TmuxLayoutBoardProps {
  window: SnapshotWindow;
  paneHref: (pane: SnapshotPane) => string | null;
  onAfterChange?: () => void;
}

export function TmuxLayoutBoard({ window, paneHref, onAfterChange }: TmuxLayoutBoardProps) {
  const parsed = useMemo(() => parseTmuxLayout(window.windowLayout), [window.windowLayout]);
  const panes = useMemo(() => window.panes ?? [], [window.panes]);
  const panesByLayoutId = useMemo(() => {
    const map = new Map<string, SnapshotPane>();
    for (const pane of panes) {
      map.set(String(pane.paneId ?? "").replace(/^%/, ""), pane);
    }
    return map;
  }, [panes]);

  if (!parsed || parsed.leaves.length === 0) return null;

  const terminalCellAspect = 0.56;
  const terminalAspectRatio = Math.max(1, (parsed.width * terminalCellAspect) / Math.max(1, parsed.height));

  return (
    <div
      className="relative w-full h-[clamp(380px,60vh,680px)] overflow-hidden"
      style={{ aspectRatio: terminalAspectRatio }}
    >
      {parsed.leaves.map((leaf, index) => {
        const pane = panesByLayoutId.get(leaf.layoutPaneId) ?? panes[index];
        if (!pane) return null;
        return (
          <LayoutPane
            key={pane.paneId ?? `${index}`}
            pane={pane}
            leaf={leaf}
            parsedWidth={parsed.width}
            parsedHeight={parsed.height}
            paneHref={paneHref}
            onAfterChange={onAfterChange}
          />
        );
      })}
    </div>
  );
}
