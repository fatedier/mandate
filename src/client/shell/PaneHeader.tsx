import { useLocation } from "react-router";
import { PaneZoomButton } from "@/components/PaneZoomButton";
import { useRouteFeature } from "@/hooks/useRouteFeature";
import { buildBreadcrumb } from "@/lib/breadcrumb";
import { cn } from "@/lib/utils";
import { useAgentChatStore } from "@/store/agent-chat";
import { useProjectsStore } from "@/store/projects";
import { usePaneTitleClaimed } from "@/shell/pane-header-context";
import { PaneHeaderActionsSlot, PaneHeaderTitleSlot } from "@/shell/pane-header-slots";

/** The 52px band at the top of the left pane (desktop only). It is the same
 *  height as the sidebar's header zone and the chat header, so the top edge
 *  reads as one continuous band across the window. The whole band drags the
 *  window in the desktop shell: `data-tauri-drag-region` here, plus the
 *  delegated handler in `shell/tauri-drag-region.ts` that lets children pass
 *  the gesture up while interactive elements keep their clicks. */
export function PaneHeader() {
  const { pathname } = useLocation();
  const bySlug = useProjectsStore((s) => s.bySlug);
  const routeFeature = useRouteFeature();
  const drawerMode = useAgentChatStore((s) => s.drawerMode);
  const setDrawerMode = useAgentChatStore((s) => s.setDrawerMode);
  const claimed = usePaneTitleClaimed();
  const segments = buildBreadcrumb({ pathname, bySlug });
  const current = segments[segments.length - 1];

  return (
    <header
      data-slot="pane-header"
      data-tauri-drag-region
      className="flex h-13 shrink-0 items-center gap-2 pl-5 pr-3"
    >
      {!claimed && current && (
        <h1
          data-slot="pane-default-title"
          className={cn(
            "min-w-0 flex-1 truncate text-sm font-semibold text-foreground",
            current.mono && "font-mono text-xs font-medium"
          )}
        >
          {current.label}
        </h1>
      )}
      <PaneHeaderTitleSlot />
      <PaneHeaderActionsSlot />
      {routeFeature && (
        <PaneZoomButton
          pane="worker"
          zoomed={drawerMode === "worker"}
          onClick={() => setDrawerMode(drawerMode === "worker" ? "side" : "worker")}
        />
      )}
    </header>
  );
}
