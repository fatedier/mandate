import { Link, useLocation } from "react-router";
import { Fragment } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useProjectsStore } from "@/store/projects";
import { MobileNav } from "@/shell/MobileNav";
import { TopBarChatTrigger } from "@/shell/TopBarChatTrigger";
import { TopBarActionsSlot } from "@/shell/topbar-actions";
import { buildBreadcrumb } from "@/lib/breadcrumb";
import { cn } from "@/lib/utils";
import { useRouteFeature } from "@/hooks/useRouteFeature";
import { useAgentChatStore } from "@/store/agent-chat";
import { PaneZoomButton } from "@/components/PaneZoomButton";

/** Global top bar. Stable across all routes. Sticky at top, z-40 (under
 *  modals at z-50, above page content). Desktop has no chat trigger — the
 *  Assistant dock's collapsed strip is the persistent entry point; mobile
 *  keeps the trigger as the MobileChatSheet opener. */
export function TopBar() {
  const isMobile = useIsMobile();
  const { pathname } = useLocation();
  const bySlug = useProjectsStore((s) => s.bySlug);
  const segments = buildBreadcrumb({ pathname, bySlug });
  const routeFeature = useRouteFeature();
  const drawerMode = useAgentChatStore((s) => s.drawerMode);
  const setDrawerMode = useAgentChatStore((s) => s.setDrawerMode);

  if (isMobile) {
    return (
      <header
        className="h-12 shrink-0 flex items-center px-2 gap-2 border-b border-border-soft bg-background/95 backdrop-blur sticky top-0 z-40"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <MobileNav />
        <nav aria-label="Breadcrumb" className="flex items-center gap-1 min-w-0 flex-1 overflow-hidden">
          {segments.map((seg, i) => (
            <Fragment key={i}>
              {i > 0 && <span aria-hidden className="text-chrome/50 shrink-0">/</span>}
              {seg.href ? (
                <Link
                  to={seg.href}
                  className={cn("text-sm text-chrome hover:text-foreground transition-colors truncate", seg.mono && "font-mono text-xs")}
                >
                  {seg.label}
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
        </nav>
        <TopBarActionsSlot />
        <TopBarChatTrigger />
      </header>
    );
  }

  return (
    <header className="h-14 shrink-0 flex items-center px-4 gap-2 border-b border-border-soft bg-background sticky top-0 z-40">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 min-w-0 flex-1">
        {segments.map((seg, i) => (
          <Fragment key={i}>
            {i > 0 && <span aria-hidden className="text-chrome/50">/</span>}
            {seg.href ? (
              <Link
                to={seg.href}
                className={cn("text-sm text-chrome hover:text-foreground transition-colors truncate", seg.mono && "font-mono text-xs")}
              >
                {seg.label}
              </Link>
            ) : (
              <span
                className={cn("text-sm font-medium text-foreground truncate", seg.mono && "font-mono text-xs")}
                aria-current="page"
              >
                {seg.label}
              </span>
            )}
          </Fragment>
        ))}
      </nav>
      <TopBarActionsSlot />
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
