import { useCallback, useRef, useState, type HTMLAttributes, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, Undo2, X } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/format";
import { useNow } from "@/hooks/useNow";
import { TabMark } from "@/components/TabMark";
import { useTabFade } from "@/hooks/useTabFade";
import { useScrollEdges } from "@/hooks/useScrollEdges";
import { usePaneHeaderHosted } from "@/shell/pane-header-context";
import { TabDrag, type TabDragProps } from "./TabDrag";

/** A closable tab after the first: a worker, a canvas, a reply, a thread. */
export interface PanelTabItem {
  id: string;
  label: string;
  /** On hover, when more than the label: a terminal's place. */
  tooltip?: string;
  /** Its kind: a worker's state dot, a canvas's kind icon. */
  icon: ReactNode;
  /** Its kind's name, its heading in the list of all tabs (Threads,
   *  Canvases, Replies, Workers). */
  group?: string;
  /** Without one the tab has no Close: a Terminals page pin, which Unpin ends. */
  onClose?: () => void;
  /** The pane id of a terminal tab. */
  dataTerminalTab?: string;
  /** Read by tests and e2e: the worker's id, the canvas's id. */
  dataWorkerTab?: string;
  dataCanvasTab?: string;
  /** The file's path. */
  dataFileTab?: string;
  /** The reply tab's id. */
  dataReplyTab?: string;
  /** The thread's id (a thread open beside the personal agent). */
  dataThreadTab?: string;
  /** The personal agent's Tasks tab. */
  dataTasksTab?: boolean;
  /** The personal agent's Notes tab. */
  dataNotesTab?: boolean;
  /** The personal agent's Calendar tab. */
  dataCalendarTab?: boolean;
  /** The task's id (a task in a tab of its own). */
  dataTaskTab?: string;
  /** Drawn after its name (the Tasks tab's count of tasks that need you). */
  after?: ReactNode;
  /** Its group, in a row that can be reordered: dragged among its group's
   *  tabs only (the Terminals page's pins, its open tabs). None, it stays. */
  order?: string;
}

/** A tab closed in the panel, as its Reopen lists it. */
export interface ReopenItem {
  id: string;
  label: string;
  icon: ReactNode;
  closedAt: number;
}

/**
 * A right panel's row of tabs (a thread's, the personal agent's): a fixed first tab,
 * then one closable tab per worker or canvas opened, then the panel's tools.
 * A tab is as wide as its name while the row has room; when it has not, the
 * closable tabs share it equally from a floor that leaves the name 102px, and
 * under that the row scrolls with no bar, fades on the side that has more and
 * keeps the open tab clear of the fade. Names matter as much as the tab:
 * after a reload they arrive after the tabs and widen the row under the open
 * one. Only as far as needed, so a tab already in sight moves nothing.
 * A row with more than fits ends in "N ⌄", every tab by its whole name, and
 * what comes after the tabs (the personal agent's "+") moves out of the scrolled
 * tabs beside it, so neither goes out of sight. While something closed can
 * come back, Reopen sits before the tools.
 */
export function PanelTabRow({ first, tabs, active, onSelect, tools, after, reopen, sticky = false, fill = false, ariaLabel, onReorder, moveMenu = false }: {
  first: { label: string; icon?: ReactNode; count?: number };
  tabs: PanelTabItem[];
  /** "first", or one of `tabs`' ids. */
  active: string;
  onSelect: (id: string) => void;
  tools: ReactNode;
  /** After the last tab (the personal agent's "+"); at the row's end once the tabs
   *  scroll. */
  after?: ReactNode;
  /** The panel's recently closed tabs, newest first, and how one opens again. */
  reopen?: { entries: ReopenItem[]; onReopen: (id: string) => void };
  /** The phone's sheet: the row stays pinned while the sheet's body scrolls. */
  sticky?: boolean;
  /** In a header's title (the Terminals page's): the row takes the room it
   *  is given, its tools at the end. */
  fill?: boolean;
  ariaLabel: string;
  /** Given, the tabs with an `order` can be dragged; one dropped on another
   *  of its group takes that one's place. */
  onReorder?: (id: string, overId: string) => void;
  /** With `onReorder`: a mouse's right-click on a tab with an `order` offers
   *  Move left and Move right, a place at a time among its group's tabs, the
   *  way without dragging. Never a finger's: its hold starts a drag. */
  moveMenu?: boolean;
}) {
  // The shown tab is kept in view, and the row's edges measured again, when
  // what decides the tabs' places changes: which tabs there are and which
  // come before the shown one, by id, name and Close (a pin unpinned gains
  // one, and the row may no longer fit; two of one name swapped round past
  // it count). Tabs moved about elsewhere in the row (one dropped at its far
  // end) leave the row where the person is looking.
  const named = (list: PanelTabItem[]) => list.map((t) => `${t.id}\t${t.label}\t${t.onClose ? "×" : ""}`).sort().join("\n");
  const shownAt = tabs.findIndex((t) => t.id === active);
  const { ref: tabsRef, more, onFocus: revealTab } = useScrollEdges<HTMLDivElement>(`${active}\n${named(tabs.slice(0, Math.max(0, shownAt)))}\n\n${named(tabs)}`);
  // Taking `after` out of the scrolled tabs leaves them less room, so a row
  // that scrolled goes on scrolling: no back and forth. The list, opened,
  // stays until it is closed, though the tabs closed from it leave a row
  // that fits.
  const [listOpen, setListOpen] = useState(false);
  const listed = more !== "none" || listOpen;
  const focusShownTab = () => tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  // What the tab chosen next shows, under the row, fades in.
  const headerRef = useRef<HTMLDivElement>(null);
  useTabFade(headerRef, active);
  // Beside a chat pane's own header the row is the band over the panel: its
  // height, and it drags the window as the rest of the band does.
  const banded = usePaneHeaderHosted() && !sticky;
  // Only a mouse opens a tab's menu, whatever the screen: a finger's hold is
  // a drag here, so neither Radix's own long press nor the context menu some
  // phones send for one may open it. Whether the press was a finger's is told
  // by the press itself (a laptop's touch screen reports a fine pointer).
  const touchedAt = useRef(0);
  const onTriggerPointerDown = (event: ReactPointerEvent) => {
    if (event.pointerType === "mouse") {
      touchedAt.current = 0;
      return;
    }
    touchedAt.current = Date.now();
    event.preventDefault();
  };
  const onTriggerContextMenu = (event: ReactMouseEvent) => {
    if (Date.now() - touchedAt.current < 1500) event.preventDefault();
  };
  // One tab as drawn; in a row that can be reordered TabDrag draws it, and
  // a copy of it carried in the page's top layer. The copy has no menu.
  const drawTab = (tab: PanelTabItem, drag?: TabDragProps) => {
    const drawn = drawnTab(tab, drag);
    if (!moveMenu || !onReorder || tab.order === undefined || drag?.lifted) return drawn;
    const group = tabs.filter((t) => t.order === tab.order);
    const at = group.findIndex((t) => t.id === tab.id);
    const left = group[at - 1];
    const right = group[at + 1];
    return (
      <ContextMenu key={tab.id} modal={false}>
        <ContextMenuTrigger asChild onPointerDown={onTriggerPointerDown} onContextMenu={onTriggerContextMenu}>{drawn}</ContextMenuTrigger>
        <ContextMenuContent className="min-w-[160px]">
          <ContextMenuItem disabled={!left} onSelect={() => { if (left) onReorder(tab.id, left.id); }}>
            <ArrowLeft />
            Move left
          </ContextMenuItem>
          <ContextMenuItem disabled={!right} onSelect={() => { if (right) onReorder(tab.id, right.id); }}>
            <ArrowRight />
            Move right
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };
  const drawnTab = (tab: PanelTabItem, drag?: TabDragProps) => (
    <PanelTab key={tab.id} drag={drag} active={active === tab.id} onClick={() => onSelect(tab.id)} closable dataWorkerTab={tab.dataWorkerTab} dataCanvasTab={tab.dataCanvasTab} dataFileTab={tab.dataFileTab} dataReplyTab={tab.dataReplyTab} dataThreadTab={tab.dataThreadTab} dataTasksTab={tab.dataTasksTab} dataNotesTab={tab.dataNotesTab} dataCalendarTab={tab.dataCalendarTab} dataTaskTab={tab.dataTaskTab} dataTerminalTab={tab.dataTerminalTab}>
      {tab.icon}
      {/* On a touch screen Close is the tab's last 44px and the name
          keeps 44px of its own (a worker can be named "x"). Cut short
          when the tabs share the row: the whole of it on hover. */}
      <span title={tab.tooltip ?? tab.label} className="max-w-56 truncate pointer-coarse:min-w-7">{tab.label}</span>
      {tab.after}
      {tab.onClose && <span
        role="button"
        tabIndex={0}
        aria-label={`Close ${tab.label}`}
        onClick={(e) => { e.stopPropagation(); tab.onClose?.(); }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          e.stopPropagation();
          tab.onClose?.();
        }}
        className="hit relative -mr-1 shrink-0 rounded-xs p-0.5 text-faint hover:bg-background/60 hover:text-foreground pointer-coarse:-mr-2.5 pointer-coarse:flex pointer-coarse:w-11 pointer-coarse:self-stretch pointer-coarse:items-center pointer-coarse:justify-center"
      >
        <X className="h-3 w-3" />
      </span>}
    </PanelTab>
  );
  return (
    // 8px apart on a touch screen: a tab's Close reaches 8px past the tab,
    // and the tools 8px past their boxes. The tabs scroll on their own, so
    // the tools stay in sight however many are open.
    <div
      ref={headerRef}
      data-tauri-drag-region={banded || undefined}
      className={cn("flex items-center gap-0.5 pr-2 pointer-coarse:gap-2", fill ? "min-w-0 flex-1" : "shrink-0", banded ? "h-13" : "h-11", sticky && "sticky top-0 z-20 bg-background")}
    >
      {/* The padding inside the scroller: a tab's touch area reaches past
          it. `relative`: the row is its tabs' offsetParent, which the
          scroll that keeps the open one in view measures against. */}
      <div
        ref={tabsRef}
        data-more={more === "none" ? undefined : more}
        onFocus={revealTab}
        className="scroll-x-edges relative flex h-full min-w-0 flex-1 items-center gap-0.5 px-2 pointer-coarse:gap-2 has-[[data-dragging]]:[&>[data-slot=tab-mark]]:invisible"
        role="tablist"
        aria-label={ariaLabel}
      >
        <TabMark selected={active} />
        <PanelTab active={active === "first"} onClick={() => onSelect("first")}>
          {first.icon}
          {first.label}
          {first.count !== undefined && <span className="num text-2xs text-faint">{first.count}</span>}
        </PanelTab>
        {onReorder ? <TabDrag tabs={tabs} onReorder={onReorder}>{drawTab}</TabDrag> : tabs.map((tab) => drawTab(tab))}
        {!listed && after}
      </div>
      {listed && <AllTabsMenu first={first} tabs={tabs} active={active} onSelect={onSelect} open={listOpen} onOpenChange={setListOpen} onButtonGone={focusShownTab} />}
      {listed && after}
      {reopen && reopen.entries.length > 0 && <ReopenMenu entries={reopen.entries} onReopen={reopen.onReopen} onButtonGone={focusShownTab} />}
      {tools}
    </div>
  );
}

function PanelTab({ drag, active, onClick, children, closable = false, dataWorkerTab, dataCanvasTab, dataFileTab, dataReplyTab, dataThreadTab, dataTasksTab, dataNotesTab, dataCalendarTab, dataTaskTab, dataTerminalTab, ref, style, ...trigger }: {
  /** In a row that can be reordered (TabDrag). */
  drag?: TabDragProps;
  /** A context menu's trigger (Move left / Move right), passed through to the tab. */
  ref?: Ref<HTMLDivElement>;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  closable?: boolean;
  dataWorkerTab?: string;
  dataCanvasTab?: string;
  dataFileTab?: string;
  dataReplyTab?: string;
  dataThreadTab?: string;
  dataTasksTab?: boolean;
  dataNotesTab?: boolean;
  dataCalendarTab?: boolean;
  dataTaskTab?: string;
  dataTerminalTab?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, "onClick" | "children">) {
  const setNode = drag?.setNodeRef;
  const setRef = useCallback((node: HTMLDivElement | null) => {
    setNode?.(node);
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  }, [setNode, ref]);
  // The copy carried under the pointer is a picture of the tab: no tab to
  // reach, name or find by its ids.
  const copy = drag?.lifted === true;
  const ids = copy ? {} : {
    "data-worker-tab": dataWorkerTab,
    "data-canvas-tab": dataCanvasTab,
    "data-file-tab": dataFileTab,
    "data-reply-tab": dataReplyTab,
    "data-thread-tab": dataThreadTab,
    "data-tasks-tab": dataTasksTab ? "" : undefined,
    "data-notes-tab": dataNotesTab ? "" : undefined,
    "data-calendar-tab": dataCalendarTab ? "" : undefined,
    "data-task-tab": dataTaskTab,
    "data-terminal-tab": dataTerminalTab
  };
  return (
    <div
      {...trigger}
      ref={setRef}
      style={style || drag?.style ? { ...style, ...drag?.style } : undefined}
      {...drag?.listeners}
      data-sort-order={drag?.order}
      // A drag along the row, not the bottom sheet's (vaul) up and down.
      data-vaul-no-drag={drag?.order !== undefined && !copy ? "" : undefined}
      data-dragging={drag?.dragging || undefined}
      data-carried={copy || undefined}
      aria-hidden={copy || undefined}
      role="tab"
      tabIndex={copy ? -1 : 0}
      aria-selected={active}
      {...ids}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      className={cn(
        "hit relative flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-sm px-2.5 text-xs font-medium transition-colors",
        // A closable tab is as wide as its name while the row has room. When
        // it has not, the closable tabs share the row equally, from a floor
        // that leaves the name 102px (the start of a name still reads): its
        // padding and Close on top, Close being 44px on a touch screen.
        // Under the floor the row scrolls. `max-w-max` stops a tab at its
        // own name, so a short one stays short; `min-w-0` lets the floor,
        // not the name, be the least. The icon (14px and its gap) sits
        // before the name, so the floor grows by it.
        closable && "min-w-0 max-w-max grow basis-[10rem] pointer-coarse:basis-[11.375rem]",
        // Held to be dragged: no text selection or callout on a long press,
        // and a swipe scrolls the row until the hold has made it a drag.
        drag?.order !== undefined && "select-none [-webkit-touch-callout:none] touch-manipulation",
        // Carried, its place stays empty, where it will land; the copy is a
        // solid surface, as a menu's, over its neighbours, with no hover fill
        // (the pointer is on it the whole way; a see-through fill looked
        // muddled over the tabs under it).
        drag?.dragging && "invisible",
        copy
          ? "cursor-grabbing bg-popover text-foreground shadow-md ring-1 ring-border"
          // The active tab's fill is the row's sliding TabMark.
          : active ? "text-foreground" : "text-chrome hover:bg-sel hover:text-foreground"
      )}
    >
      {children}
    </div>
  );
}

/** "N ⌄" at the end of a row with more than fits: every tab by its whole
 *  name, the first, then each kind under its name in the row's order, the
 *  shown one marked, a long name wrapped. Choosing one shows it; its × (or
 *  Delete, from the keyboard) closes it as the tab's own would, and the list
 *  stays open for the next. */
function AllTabsMenu({ first, tabs, active, onSelect, open, onOpenChange, onButtonGone }: {
  first: { label: string; icon?: ReactNode };
  tabs: PanelTabItem[];
  active: string;
  onSelect: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Closed on a row that fits now, the list took its button with it: where
   *  the focus it would have given back goes instead. */
  onButtonGone: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const groups: Array<{ name: string | undefined; tabs: PanelTabItem[] }> = [];
  for (const tab of tabs) {
    const group = groups.find((g) => g.name === tab.group);
    if (group) group.tabs.push(tab);
    else groups.push({ name: tab.group, tabs: [tab] });
  }
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        {/* 44px wide on a touch screen: its touch area stays clear of the
            tabs and of what follows. */}
        <button
          ref={buttonRef}
          type="button"
          aria-label="All tabs"
          title="All tabs"
          className="hit relative flex h-7 shrink-0 items-center justify-center gap-0.5 rounded-sm px-1.5 text-xs text-chrome hover:bg-sel hover:text-foreground data-[state=open]:bg-sel data-[state=open]:text-foreground pointer-coarse:min-w-11"
        >
          <span className="num">{tabs.length + 1}</span>
          <ChevronDown aria-hidden className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-slot="all-tabs-menu"
        align="end"
        className="w-80 max-w-[calc(100vw-2rem)]"
        // The menu's own last step on closing, after it is gone. Last used
        // from the keyboard (the default not prevented) the focus goes back
        // to its button, or, the button gone too, to the shown tab, unless
        // something else has it; after a pointer it stays where it is.
        onCloseAutoFocus={(event) => {
          if (event.defaultPrevented || buttonRef.current?.isConnected) return;
          const holder = document.activeElement;
          if (holder && holder !== document.body) return;
          event.preventDefault();
          onButtonGone();
        }}
      >
        <AllTabsItem label={first.label} icon={first.icon} current={active === "first"} onSelect={() => onSelect("first")} />
        {groups.map((group) => (
          <div key={group.name ?? ""} role="group" aria-label={group.name}>
            <DropdownMenuSeparator />
            {group.name && <DropdownMenuLabel data-slot="all-tabs-group" className="text-2xs font-medium text-faint">{group.name}</DropdownMenuLabel>}
            {group.tabs.map((tab) => (
              <AllTabsItem key={tab.id} label={tab.label} icon={tab.icon} current={active === tab.id} onSelect={() => onSelect(tab.id)} onClose={tab.onClose} />
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Reopen: the panel's recently closed tabs, newest first, each by its icon,
 *  name and age; choosing one opens it again. The last one reopened takes
 *  the button with it: the focus it would have given back goes to the shown
 *  tab, the one just opened. */
function ReopenMenu({ entries, onReopen, onButtonGone }: {
  entries: ReopenItem[];
  onReopen: (id: string) => void;
  onButtonGone: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          ref={buttonRef}
          type="button"
          aria-label="Reopen a closed tab"
          title="Reopen a closed tab"
          className="hit relative flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-chrome hover:bg-sel hover:text-foreground data-[state=open]:bg-sel data-[state=open]:text-foreground"
        >
          <Undo2 aria-hidden className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-slot="recently-closed-menu"
        align="end"
        className="w-72 max-w-[calc(100vw-2rem)]"
        onCloseAutoFocus={(event) => {
          if (event.defaultPrevented || buttonRef.current?.isConnected) return;
          const holder = document.activeElement;
          if (holder && holder !== document.body) return;
          event.preventDefault();
          onButtonGone();
        }}
      >
        <DropdownMenuLabel data-slot="recently-closed-label" className="text-2xs font-medium text-faint">Recently closed</DropdownMenuLabel>
        {entries.map((entry) => (
          <DropdownMenuItem key={entry.id} onSelect={() => onReopen(entry.id)} className="gap-2">
            {entry.icon}
            <span data-slot="recently-closed-name" title={entry.label} className="min-w-0 flex-1 truncate">{entry.label}</span>
            <ClosedAge at={entry.closedAt} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** How long ago a tab closed, read when the menu opens and kept current. */
function ClosedAge({ at }: { at: number }) {
  const now = useNow();
  return <span data-slot="recently-closed-age" className="num shrink-0 text-2xs text-faint">{formatRelativeTime(at, now)}</span>;
}

function AllTabsItem({ label, icon, current, onSelect, onClose }: {
  label: string;
  icon?: ReactNode;
  current: boolean;
  onSelect: () => void;
  onClose?: () => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      onKeyDown={onClose ? (e) => {
        if (e.key !== "Delete" && e.key !== "Backspace") return;
        e.preventDefault();
        onClose();
      } : undefined}
      aria-keyshortcuts={onClose ? "Delete" : undefined}
      data-current={current || undefined}
      aria-current={current || undefined}
      className={cn("gap-2", current && "bg-sel text-foreground")}
    >
      {icon}
      {/* The whole name: the list is where a name cut short in the row is read. */}
      <span data-slot="all-tabs-name" title={label} className="line-clamp-3 min-w-0 flex-1 [overflow-wrap:anywhere]">{label}</span>
      {onClose && (
        // Pressed, it closes the tab, not the list, and chooses nothing: an
        // item pressed is chosen at the pointer's release too.
        <span
          role="button"
          aria-label={`Close ${label}`}
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onPointerUp={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}
          className="hit relative -mr-1 shrink-0 rounded-xs p-0.5 text-faint hover:bg-background/60 hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </span>
      )}
    </DropdownMenuItem>
  );
}