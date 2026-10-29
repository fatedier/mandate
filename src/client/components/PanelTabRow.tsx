import { useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { TabMark } from "@/components/TabMark";
import { useTabFade } from "@/hooks/useTabFade";
import { useScrollEdges } from "@/hooks/useScrollEdges";

/** A closable tab after the first: a worker, or a canvas. */
export interface PanelTabItem {
  id: string;
  label: string;
  /** Its kind: a worker's state dot, a canvas's kind icon. */
  icon: ReactNode;
  onClose: () => void;
  /** Read by tests and e2e: the worker's feature id, the canvas's id. */
  dataWorkerTab?: string;
  dataCanvasTab?: string;
}

/**
 * A right panel's row of tabs (a thread's, Your agent's): a fixed first tab,
 * then one closable tab per worker or canvas opened, then the panel's tools.
 * A tab is as wide as its name while the row has room; when it has not, the
 * closable tabs share it equally from a floor that leaves the name 102px, and
 * under that the row scrolls with no bar, fades on the side that has more and
 * keeps the open tab clear of the fade. Names matter as much as the tab:
 * after a reload they arrive after the tabs and widen the row under the open
 * one. Only as far as needed, so a tab already in sight moves nothing.
 */
export function PanelTabRow({ first, tabs, active, onSelect, tools, sticky = false, ariaLabel }: {
  first: { label: string; icon?: ReactNode; count?: number };
  tabs: PanelTabItem[];
  /** "first", or one of `tabs`' ids. */
  active: string;
  onSelect: (id: string) => void;
  tools: ReactNode;
  /** The phone's sheet: the row stays pinned while the sheet's body scrolls. */
  sticky?: boolean;
  ariaLabel: string;
}) {
  const names = tabs.map((t) => t.label).join("\n");
  const { ref: tabsRef, more, onFocus: revealTab } = useScrollEdges<HTMLDivElement>(`${active}\n${names}`);
  // What the tab chosen next shows, under the row, fades in.
  const headerRef = useRef<HTMLDivElement>(null);
  useTabFade(headerRef, active);
  return (
    // 8px apart on a touch screen: a tab's Close reaches 8px past the tab,
    // and the tools 8px past their boxes. The tabs scroll on their own, so
    // the tools stay in sight however many are open.
    <div ref={headerRef} className={cn("flex h-11 shrink-0 items-center gap-0.5 pr-2 pointer-coarse:gap-2", sticky && "sticky top-0 z-20 bg-background")}>
      {/* The padding inside the scroller: a tab's touch area reaches past
          it. `relative`: the row is its tabs' offsetParent, which the
          scroll that keeps the open one in view measures against. */}
      <div
        ref={tabsRef}
        data-more={more === "none" ? undefined : more}
        onFocus={revealTab}
        className="scroll-x-edges relative flex h-full min-w-0 flex-1 items-center gap-0.5 px-2 pointer-coarse:gap-2"
        role="tablist"
        aria-label={ariaLabel}
      >
        <TabMark selected={active} />
        <PanelTab active={active === "first"} onClick={() => onSelect("first")}>
          {first.icon}
          {first.label}
          {first.count !== undefined && <span className="num text-2xs text-faint">{first.count}</span>}
        </PanelTab>
        {tabs.map((tab) => (
          <PanelTab key={tab.id} active={active === tab.id} onClick={() => onSelect(tab.id)} closable dataWorkerTab={tab.dataWorkerTab} dataCanvasTab={tab.dataCanvasTab}>
            {tab.icon}
            {/* On a touch screen Close is the tab's last 44px and the name
                keeps 44px of its own (a worker can be named "x"). Cut short
                when the tabs share the row: the whole of it on hover. */}
            <span title={tab.label} className="max-w-56 truncate pointer-coarse:min-w-7">{tab.label}</span>
            <span
              role="button"
              tabIndex={0}
              aria-label={`Close ${tab.label}`}
              onClick={(e) => { e.stopPropagation(); tab.onClose(); }}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                e.stopPropagation();
                tab.onClose();
              }}
              className="hit relative -mr-1 shrink-0 rounded-xs p-0.5 text-faint hover:bg-background/60 hover:text-foreground pointer-coarse:-mr-2.5 pointer-coarse:flex pointer-coarse:w-11 pointer-coarse:self-stretch pointer-coarse:items-center pointer-coarse:justify-center"
            >
              <X className="h-3 w-3" />
            </span>
          </PanelTab>
        ))}
      </div>
      {tools}
    </div>
  );
}

function PanelTab({ active, onClick, children, closable = false, dataWorkerTab, dataCanvasTab }: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  closable?: boolean;
  dataWorkerTab?: string;
  dataCanvasTab?: string;
}) {
  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      data-worker-tab={dataWorkerTab}
      data-canvas-tab={dataCanvasTab}
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
        // The active tab's fill is the row's sliding TabMark.
        active ? "text-foreground" : "text-chrome hover:bg-sel hover:text-foreground"
      )}
    >
      {children}
    </div>
  );
}
