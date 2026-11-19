import { Link, useLocation } from "react-router";
import { Fragment } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useProjectsStore } from "@/store/projects";
import { MobileNav } from "@/shell/MobileNav";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { PaneHeaderActionsSlot, PaneHeaderTitleSlot } from "@/shell/pane-header-slots";
import { usePaneTitleClaimed } from "@/shell/pane-header-context";
import { buildBreadcrumb } from "@/lib/breadcrumb";
import { cn } from "@/lib/utils";
import { ConnectionIndicator } from "@/shell/ConnectionIndicator";
import { useReconnecting } from "@/hooks/useReconnecting";

/** Mobile header only. Desktop has no top bar: the pane's PaneHeader carries
 *  the title and page actions. A page that claims the title (a canvas: its
 *  URL holds only an id) replaces the breadcrumb here, as it does there. */
export function TopBar() {
  const isMobile = useIsMobile();
  const claimed = usePaneTitleClaimed();
  const { pathname } = useLocation();
  const bySlug = useProjectsStore((s) => s.bySlug);
  const threads = useManagerThreadsStore((s) => s.threads);
  const archived = useManagerThreadsStore((s) => s.archived);
  const reconnecting = useReconnecting();
  if (!isMobile) return null;
  const segments = buildBreadcrumb({ pathname, bySlug, threadTitle: (id) => threads.get(id)?.title ?? archived.find((t) => t.id === id)?.title });

  return (
    <header
      // A container, as the desktop pane header is: a claimed title's
      // secondary line shows once the bar has room for it.
      // 48px below the top safe area: in full screen under a camera cutout the
      // page reaches under it (env() is 0 otherwise), and a fixed 48px with
      // the inset as padding pushed the bar's row out over the content.
      className="@container h-[calc(3rem+env(safe-area-inset-top,0px))] shrink-0 flex items-center px-2 gap-2 border-b border-border-soft bg-background/95 backdrop-blur sticky top-0 z-40"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <MobileNav />
      {/* On a touch screen the trail clips (it truncates) 12px further up and
          down, given back by margin, so a crumb's touch area fits inside. */}
      {!claimed && <nav aria-label="Breadcrumb" className={cn("flex items-center gap-1 min-w-0 flex-1 overflow-hidden pointer-coarse:-my-3 pointer-coarse:py-3", reconnecting && "flex-initial shrink-[10000]")}>
        {segments.map((seg, i) => (
          <Fragment key={i}>
            {i > 0 && <span aria-hidden className="text-chrome/50 shrink-0">/</span>}
            {seg.href ? (
              <Link
                to={seg.href}
                className={cn("hit relative min-w-0 text-sm text-chrome hover:text-foreground transition-colors pointer-coarse:min-w-11", seg.mono && "font-mono text-xs")}
              >
                {/* Truncated inside: overflow on the link would clip its touch area. */}
                <span className="block truncate">{seg.label}</span>
              </Link>
            ) : (
              <span
                className={cn("text-sm font-semibold text-foreground truncate", seg.mono && "font-mono text-xs")}
                aria-current="page"
              >
                {seg.label}
              </span>
            )}
          </Fragment>
        ))}
      </nav>}
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
