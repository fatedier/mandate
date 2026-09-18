import type { ReactNode } from "react";

import { PillTabs } from "@/components/PillTabs";
import { RefreshButton } from "@/components/RefreshButton";
import { PaneHeaderActions } from "@/shell/pane-header-slots";
import { MEMORY_VIEWS, type MemoryView } from "./memory-views";

/**
 * Page frame shared by all three views: the refresh action portals into the
 * pane header band, then the view switcher, then the view. The frame is
 * identical on every view, deliberately, so the tab strip never moves under
 * the cursor that just clicked it.
 */
export function MemoryShell({
  view,
  setView,
  refreshing,
  onRefresh,
  children
}: {
  view: MemoryView;
  setView: (next: MemoryView) => void;
  refreshing: boolean;
  onRefresh: () => void;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="page-column"
      className="@container mx-auto flex w-full max-w-[1280px] flex-col gap-6 px-4 pt-1 pb-6 md:px-8"
    >
      <PaneHeaderActions>
        <RefreshButton refreshing={refreshing} onRefresh={onRefresh} size="icon-xs" />
      </PaneHeaderActions>
      <PillTabs
        items={MEMORY_VIEWS}
        value={view}
        onChange={setView}
        aria-label="Memory views"
        role="nav"
      />
      {children}
    </div>
  );
}
