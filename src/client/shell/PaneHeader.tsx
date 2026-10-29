import { useLocation } from "react-router";
import { buildBreadcrumb } from "@/lib/breadcrumb";
import { cn } from "@/lib/utils";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useProjectsStore } from "@/store/projects";
import { usePaneTitleClaimed } from "@/shell/pane-header-context";
import { PaneHeaderActionsSlot, PaneHeaderTitleSlot } from "@/shell/pane-header-slots";
import { ConnectionIndicator } from "@/shell/ConnectionIndicator";
import { useReconnecting } from "@/hooks/useReconnecting";

/** The 52px band at the top of the left pane (desktop only). It is the same
 *  height as the sidebar's header zone and the chat header, so the top edge
 *  reads as one continuous band across the window. The whole band drags the
 *  window in the desktop shell: `data-tauri-drag-region` here, plus the
 *  delegated handler in `shell/tauri-drag-region.ts` that lets children pass
 *  the gesture up while interactive elements keep their clicks. */
export function PaneHeader() {
  const { pathname } = useLocation();
  const bySlug = useProjectsStore((s) => s.bySlug);
  const threads = useManagerThreadsStore((s) => s.threads);
  const archived = useManagerThreadsStore((s) => s.archived);
  const claimed = usePaneTitleClaimed();
  const segments = buildBreadcrumb({ pathname, bySlug, threadTitle: (id) => threads.get(id)?.title ?? archived.find((t) => t.id === id)?.title });
  const current = segments[segments.length - 1];
  const reconnecting = useReconnecting();

  return (
    <header
      data-slot="pane-header"
      data-tauri-drag-region
      // A container: the context pill in the actions sizes itself to it.
      className="@container flex h-13 shrink-0 items-center gap-2 pl-5 pr-3"
    >
      {!claimed && current && (
        <h1
          data-slot="pane-default-title"
          className={cn(
            "min-w-0 flex-1 truncate text-sm font-semibold text-foreground",
            current.mono && "font-mono text-xs font-medium",
            reconnecting && "flex-initial shrink-[10000]"
          )}
        >
          {current.label}
        </h1>
      )}
      {/* While it shows, a title a page claims sits at its own width with the
          note beside it — unless it holds an input (a rename): that keeps
          the row. */}
      <PaneHeaderTitleSlot className={reconnecting ? "flex-initial shrink-[10000] has-[input]:flex-1" : undefined} />
      {reconnecting && <ConnectionIndicator />}
      {/* The title gave up the row's slack: the actions still end the row. */}
      <PaneHeaderActionsSlot className={reconnecting ? "ml-auto" : undefined} />
    </header>
  );
}
