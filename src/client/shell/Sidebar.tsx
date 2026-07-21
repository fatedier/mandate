import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Link, useLocation } from "react-router";
import { ArrowLeft, PanelLeft, PanelLeftClose } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { navMain, navSystem, navSettings, type NavItem } from "@/shell/nav-config";
import { NavItemRow } from "@/shell/NavItemRow";
import { FeaturesNavSection } from "@/shell/FeaturesNavSection";
import { useAttentionCount } from "@/hooks/useAttentionCount";
import {
  useUIStore,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_DEFAULT
} from "@/store/ui";
import { cn } from "@/lib/utils";
import { getSectionUrl, isInSection } from "@/lib/section-memory";
import { SETTINGS_NAV_GROUPS, sectionFromParam } from "@/routes/settings/settings-nav";

const brandLogoSrc = "/brand/mandate-logo-panes.svg";

export function Sidebar() {
  const collapsed = useUIStore((s) => s.sidebarCollapsed);
  const setCollapsed = useUIStore((s) => s.setSidebarCollapsed);
  const attentionCount = useAttentionCount();
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth);
  const { pathname, search } = useLocation();
  // Settings swaps the sidebar's body for its own section nav (Linear-style
  // contextual sidebar) instead of growing a second rail inside the page.
  const settingsMode = pathname.startsWith("/settings");
  const settingsSection = sectionFromParam(new URLSearchParams(search).get("tab"));
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  // State, not a ref: the width transition has to be off while dragging or the
  // panel lags 200ms behind the pointer, and turning it off needs a render.
  const [dragging, setDragging] = useState(false);

  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragStateRef.current = { startX: e.clientX, startWidth: sidebarWidth };
    setDragging(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Some pointer sources reject setPointerCapture; the drag still works.
    }
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state) return;
    // Anchored to the left edge, so drag-right grows it — the mirror of the
    // chat drawer, which is anchored right and grows on drag-left.
    setSidebarWidth(state.startWidth + (e.clientX - state.startX));
  };

  const onResizeEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStateRef.current) return;
    dragStateRef.current = null;
    setDragging(false);
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Defensive: see onResizeStart.
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  const renderItem = (item: NavItem) => {
    const active = isInSection(pathname, item.to);
    const target = active ? item.to : getSectionUrl(item.to);
    const isHome = item.to === "/projects";

    if (collapsed) {
      return (
        <Tooltip key={item.to}>
          <TooltipTrigger asChild>
            <NavItemRow
              item={item}
              active={active}
              target={target}
              collapsed
              badgeCount={isHome ? attentionCount : undefined}
            />
          </TooltipTrigger>
          <TooltipContent side="right">{item.label}</TooltipContent>
        </Tooltip>
      );
    }

    return (
      <NavItemRow
        key={item.to}
        item={item}
        active={active}
        target={target}
        badgeCount={isHome ? attentionCount : undefined}
      />
    );
  };

  const groupClass = cn("flex flex-col", collapsed ? "gap-1 items-center" : "gap-0.5");

  return (
    <aside
      className={cn(
        "relative flex h-full flex-col bg-panel py-2",
        // The transition is for the collapse toggle. During a drag it has to be
        // off, or the edge trails the pointer by 200ms and the drag feels stuck.
        !dragging && "transition-[width] duration-200",
        collapsed ? "w-12 items-center" : "px-2"
      )}
      style={collapsed ? undefined : { width: `${sidebarWidth}px` }}
      data-collapsed={collapsed ? "true" : "false"}
    >
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuemin={SIDEBAR_WIDTH_MIN}
          aria-valuemax={SIDEBAR_WIDTH_MAX}
          aria-valuenow={sidebarWidth}
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          onDoubleClick={() => setSidebarWidth(SIDEBAR_WIDTH_DEFAULT)}
          title="Drag to resize · double-click to reset"
          className="group absolute inset-y-0 right-0 z-[1] flex w-2 cursor-col-resize touch-none select-none items-stretch"
        >
          {/* Same as the chat drawer's: an 8px transparent grab area with a 1px
              stripe on the edge it borders, so nothing protrudes into the
              content column. `ml-auto` puts the stripe on the right, mirroring
              the chat's, which sits on its left. */}
          <div className="ml-auto w-px bg-transparent transition-colors group-hover:bg-primary/70 group-active:bg-primary" />
        </div>
      )}
      <div
        className={cn(
          "flex items-center h-10",
          collapsed ? "justify-center" : "justify-between px-2"
        )}
      >
        {!collapsed && (
          <Link
            to="/projects"
            className="flex min-w-0 items-center gap-2 text-base font-bold text-foreground hover:text-primary transition-colors"
          >
            <img src={brandLogoSrc} alt="" className="h-7 w-7 shrink-0" />
            <span className="truncate">Mandate</span>
          </Link>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </Button>
      </div>

      <TooltipProvider delayDuration={150}>
        {/* The nav is a scroll container, and the attention badge overhangs
            its first link by 2px on top and right (absolute -top/right-0.5).
            Anything past the padding box gets clipped (or, horizontally,
            becomes a stub scrollbar), so the badge needs headroom inside it:
            w-full (not the shrink-wrapped 40px) absorbs the right overhang,
            and mt-1.5 + pt-0.5 (same 8px total as the old mt-2) the top. */}
        <nav className={cn("flex flex-col mt-1.5 pt-0.5 flex-1 min-h-0 overflow-y-auto w-full", collapsed ? "gap-1 items-center" : "gap-0.5")}>
          {/* No role="group" on the destination clusters. Both names were
              invisible, so the split was a fact only a screen reader got — and
              "System" is a word we just decided says nothing that `Activity`
              and `Memory` do not. The `<nav>` landmark already announces the
              links. The two bands below keep their groups, because there the
              name is load-bearing: their rows are otherwise identical. */}
          {settingsMode ? (
            <SettingsSidebarNav
              collapsed={collapsed}
              section={settingsSection}
              groupClass={groupClass}
            />
          ) : (<>
          <div className={groupClass}>
            {navMain.map((item) => renderItem(item))}
          </div>

          {/* The lower-frequency destinations, rendered exactly like the rest.
              They kept a 12px gap and h-9 rows after the "System" heading went,
              but a shorter row with no separator to explain it reads as a
              rendering fault, not as a category. nav-config still orders them
              last, which is the whole of the distinction now. */}
          <div className={groupClass}>
            {navSystem.map((item) => renderItem(item))}
          </div>

          {/* The feature list goes last because it is the only block whose
              height varies — the Needs you band appears and disappears, and the
              feature count moves with the work. Anything below it would shift
              under the user; above it, every nav row keeps a fixed position.
              It takes the spare height (and scrolls inside itself) so Settings
              still anchors the bottom without a spacer.

              Collapsed keeps no feature list: the Home badge still reports how
              many want you, and expanding is one click. Eleven dots would be
              eight indistinguishable grey ones. */}
          {!collapsed && <FeaturesNavSection className="flex-1" />}

          {collapsed && <div className="flex-1" aria-hidden />}
          {renderItem(navSettings)}
          </>)}
        </nav>
      </TooltipProvider>
    </aside>
  );
}

/** Sidebar body while on /settings: back to the app, then the section groups.
 *  Collapsed keeps only the back affordance — the sections have no icons, so
 *  the page's tab strip takes over (it un-hides when the sidebar collapses). */
function SettingsSidebarNav({
  collapsed,
  section,
  groupClass
}: {
  collapsed: boolean;
  section: ReturnType<typeof sectionFromParam>;
  groupClass: string;
}) {
  const backRow = (
    <Link
      to="/projects"
      className={cn(
        "flex items-center gap-2 rounded-md text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
        collapsed ? "h-9 w-9 justify-center" : "px-2.5 py-1.5"
      )}
    >
      <ArrowLeft className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {!collapsed && <span>Back</span>}
    </Link>
  );
  if (collapsed) {
    return (
      <div className={groupClass}>
        <Tooltip>
          <TooltipTrigger asChild>{backRow}</TooltipTrigger>
          <TooltipContent side="right">Back</TooltipContent>
        </Tooltip>
      </div>
    );
  }
  return (
    <nav aria-label="Settings sections" className="flex flex-col gap-px">
      <div className={groupClass}>{backRow}</div>
      {SETTINGS_NAV_GROUPS.map((group) => (
        <div key={group.label} className="flex flex-col gap-px">
          <div className="label-micro px-2.5 pb-1 pt-5 text-chrome">{group.label}</div>
          {group.items.map((item) => {
            const active = item.id === section;
            return (
              <Link
                key={item.id}
                to={`/settings?tab=${item.id}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
                  active && "bg-muted font-medium text-foreground"
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
