import { Link, useLocation } from "react-router";
import { Fragment } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useProjectsStore } from "@/store/projects";
import { MobileNav } from "@/shell/MobileNav";
import { TopBarChatTrigger } from "@/shell/TopBarChatTrigger";
import { PaneHeaderActionsSlot } from "@/shell/pane-header-slots";
import { buildBreadcrumb } from "@/lib/breadcrumb";
import { cn } from "@/lib/utils";

/** Mobile header only. Desktop has no top bar: the left pane's PaneHeader
 *  carries the title and page actions, and the chat dock has its own header. */
export function TopBar() {
  const isMobile = useIsMobile();
  const { pathname } = useLocation();
  const bySlug = useProjectsStore((s) => s.bySlug);
  if (!isMobile) return null;
  const segments = buildBreadcrumb({ pathname, bySlug });

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
      <PaneHeaderActionsSlot />
      <TopBarChatTrigger />
    </header>
  );
}
