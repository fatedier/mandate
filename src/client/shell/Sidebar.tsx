import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Link, useLocation } from "react-router";
import { ArrowLeft, PanelLeft, PanelLeftClose } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { navMain, navSystem, navSettings, type NavItem } from "@/shell/nav-config";
import { NavItemRow } from "@/shell/NavItemRow";
import { NewThreadRow } from "@/shell/NewThreadRow";
import { GlobalAgentRow } from "@/shell/GlobalAgentRow";
import { FullscreenToggle } from "@/shell/FullscreenToggle";
import { ThreadsNavSection } from "@/shell/ThreadsNavSection";
import { useHomeAttention } from "@/hooks/useAttentionCount";
import {
  useUIStore,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_DEFAULT
} from "@/store/ui";
import { cn } from "@/lib/utils";
import { TitlebarStrip } from "@/shell/TitlebarStrip";
import { getSectionUrl, isInSection } from "@/lib/section-memory";
import { SETTINGS_NAV_GROUPS, sectionFromParam } from "@/routes/settings/settings-nav";
import { useSettingsSearchStore } from "@/store/settings-search";
import { VoiceDock } from "@/routes/voice/VoiceDock";

const brandLogoSrc = "/brand/mandate-logo-panes.svg";

export function Sidebar() {
  const collapsed = useUIStore((s) => s.sidebarCollapsed);
  const setCollapsed = useUIStore((s) => s.setSidebarCollapsed);
  const attention = useHomeAttention({ withoutAgent: true });
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth);
  const { pathname, search } = useLocation();
  // Settings swaps the sidebar's body for its own section nav (a contextual
  // sidebar) instead of growing a second rail inside the page.
  const settingsMode = pathname.startsWith("/settings");
  const settingsSection = sectionFromParam(new URLSearchParams(search).get("tab"));
  // While Settings' search shows its matches, which span sections, none is current.
  const settingsSearching = useSettingsSearchStore((s) => s.query.trim() !== "");
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

    if (collapsed) {
      return (
        <Tooltip key={item.to}>
          <TooltipTrigger asChild>
            <NavItemRow
              item={item}
              active={active}
              target={target}
              collapsed
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
      />
    );
  };

  const groupClass = cn("flex flex-col", collapsed ? "gap-1 items-center" : "gap-0.5");
  const gapClass = collapsed ? "gap-1 items-center" : "gap-px";

  return (
    <aside
      className={cn(
        "relative flex h-full flex-col bg-panel border-r border-border-soft pb-2.5",
        // The transition is for the collapse toggle. During a drag it has to be
        // off, or the edge trails the pointer by 200ms and the drag feels stuck.
        !dragging && "transition-[width] duration-200",
        collapsed ? "w-12 items-center" : "px-2.5"
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
          <div className="ml-auto w-px bg-transparent transition-colors group-hover:bg-border group-active:bg-border" />
        </div>
      )}
      {/* Desktop shell only: the traffic lights' strip. The header band below
          is then the same in both shells. */}
      <TitlebarStrip />
      <div
        data-slot="sidebar-header"
        data-tauri-drag-region
        // 16px between the header's two icons on a touch screen, where full
        // screen joins Collapse: their 28px boxes reach 8px each.
        className={cn("flex h-13 shrink-0 items-center", collapsed ? "justify-center" : "gap-2 px-1 pointer-coarse:gap-4")}
      >
        {/* Collapsed rail: nothing else occupies the band, so the expand
            toggle sits in it, level with the pane headers' titles. */}
        {collapsed && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-chrome hover:text-foreground"
            onClick={() => setCollapsed(false)}
            aria-label="Expand sidebar"
          >
            <PanelLeft className="size-4" />
          </Button>
        )}
        {!collapsed && (
          <Link
            to="/home"
            data-slot="brand"
            className="flex min-w-0 items-center gap-2 text-xs font-medium text-chrome transition-colors hover:text-foreground"
          >
            <img src={brandLogoSrc} alt="" className="h-4 w-4 shrink-0" />
            <span className="truncate">Mandate</span>
          </Link>
        )}
        {!collapsed && (
          <>
            <span className="flex-1" />
            <FullscreenToggle size="icon-xs" touchOnly />
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-chrome hover:text-foreground"
              onClick={() => setCollapsed(true)}
              aria-label="Collapse sidebar"
            >
              <PanelLeftClose className="size-4" />
            </Button>
          </>
        )}
      </div>

      <TooltipProvider>
        {/* The nav's upper box is a scroll container, and the collapsed
            attention badge overhangs its link by 2px on top and right
            (absolute -top/right-0.5). Anything past the padding box gets
            clipped (or, horizontally, becomes a stub scrollbar), so the badge
            needs headroom inside it: w-full (not the shrink-wrapped rail width)
            absorbs the right overhang, and the collapsed rail's pt-1 keeps the
            first link's badge off the box's top edge. */}
        {/* The collapsed rail has no room beside Expand: full screen sits
            under it, apart from the destinations. 4px down on a touch screen
            (the only place it shows), where Expand's touch area reaches 4px
            below the header; an empty slot (a mouse) takes no room. */}
        {collapsed && (
          <div className="flex shrink-0 justify-center empty:hidden pt-1 pb-2">
            <FullscreenToggle size="icon-sm" touchOnly />
          </div>
        )}
        <nav data-slot="app-nav" className={cn("flex flex-col flex-1 min-h-0 w-full", gapClass)}>
          {/* One scroller for the menu and the threads, wherever a person
              wheels. Scrolling only the threads put
              them in a box a short window squeezed while the menu above stayed
              put. */}
          <div className={cn("flex flex-col flex-1 min-h-0 overflow-y-auto w-full", gapClass, collapsed && "pt-1")}>
            {/* No role="group" on the destination clusters. Both names were
                invisible, so the split was a fact only a screen reader got — and
                "System" is a word that says nothing `Activity` and `Memory` do
                not. The `<nav>` landmark already announces the
                links. The Threads list below keeps its group, because there the
                name is load-bearing: its rows are otherwise like the links. */}
            {settingsMode ? (
              <SettingsSidebarNav
                collapsed={collapsed}
                section={settingsSearching ? null : settingsSection}
                groupClass={groupClass}
              />
            ) : (<>
            <div className={groupClass}>
              <GlobalAgentRow collapsed={collapsed} current={pathname === "/agent"} />
              <NewThreadRow collapsed={collapsed} current={pathname === "/home"} waiting={attention} />
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

            {/* Threads go last because theirs is the only height that varies.
                Anything below would shift under the user; above, every nav row
                keeps a fixed position. No workers: a worker is reached from its
                thread, and Home lists the ones that wait.

                Collapsed keeps no list: the pen icon carries the waiting count,
                and expanding is one click. */}
            {!collapsed && <ThreadsNavSection />}
            </>)}
          </div>
          {/* Under the scroller, not in it, so they anchor the bottom however
              long the list. While voice is on, from any page (Settings too):
              its state, Mute, Stop. */}
          <div className={cn("flex shrink-0 flex-col w-full empty:hidden", gapClass)}>
            <VoiceDock collapsed={collapsed} />
            {!settingsMode && renderItem(navSettings)}
          </div>
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
  section: ReturnType<typeof sectionFromParam> | null;
  groupClass: string;
}) {
  const backRow = (
    <Link
      to="/home"
      className={cn(
        "flex items-center gap-2 rounded-sm text-xs text-muted-foreground transition-colors hover:bg-sel hover:text-foreground",
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
          <div className="label-group px-2.5 pb-1 pt-5">{group.label}</div>
          {group.items.map((item) => {
            const active = item.id === section;
            return (
              <Link
                key={item.id}
                to={`/settings?tab=${item.id}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-sm px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-sel hover:text-foreground",
                  active && "bg-sel font-medium text-foreground"
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
