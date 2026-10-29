import { useScrollEdges } from "@/hooks/useScrollEdges";
import { cn } from "@/lib/utils";
import { TabMark } from "./TabMark";
import { useTabFade } from "@/hooks/useTabFade";

/** No element: nothing follows that is the panel. */
const NO_PANEL = { current: null };

/** The Feature page's pill tabs, shared. `role="tablist"` (default) gives
 *  tab / aria-selected semantics and, with `idPrefix`, the id / aria-controls
 *  pairing the Activity page's tests rely on; `role="nav"` renders a <nav>
 *  with aria-current for view switchers that are not real tab panels.
 *
 *  A row wider than its box (Settings' six sections on a phone) scrolls
 *  sideways, fades on the side that has more, and keeps the selected pill in
 *  view — scrolling only the row, never the page. */
export function PillTabs<T extends string>({
  items, value, onChange, "aria-label": ariaLabel, idPrefix, role = "tablist", fadesNext = false
}: {
  /** null: no item is current (Settings while its search shows matches). */
  items: ReadonlyArray<{ id: T; label: string }>; value: T | null; onChange: (id: T) => void;
  "aria-label": string; idPrefix?: string; role?: "tablist" | "nav";
  /** What follows the row is the panel it switches: it fades in as another
   *  tab is chosen. Not for a switch in a header, whose siblings are not. */
  fadesNext?: boolean;
}) {
  // The row's scrolling, its fades and the selected pill kept in view: one
  // mechanism with the worker panel's row of tabs.
  const { ref: rowRef, more, onFocus } = useScrollEdges<HTMLElement>(value);
  // What the tab chosen next shows fades in, when it follows the row.
  useTabFade(fadesNext ? rowRef : NO_PANEL, value);

  // Mirrors the Feature page's shipped TabButton (WindowPage.tsx): a --sel
  // fill marks the active pill (the row's sliding TabMark); no accent
  // underline, no rounded-md.
  const pill = (selected: boolean) => cn(
    // The focus ring inside the pill: the row scrolls, and clips anything outside it.
    "hit relative inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-sm px-2.5 text-xs font-medium transition-colors focus-visible:-outline-offset-2",
    // The selected pill's fill is the row's one mark (TabMark), which slides.
    selected ? "text-foreground" : "text-chrome hover:bg-sel hover:text-foreground"
  );
  // `relative`: the row is its pills' offsetParent, which the scroll above measures against.
  const rowClass = "scroll-x-edges relative flex gap-0.5 pointer-coarse:-my-2 pointer-coarse:py-2";
  const edges = more === "none" ? undefined : more;
  if (role === "nav") {
    return (
      <nav ref={rowRef} data-slot="page-tabs" data-more={edges} aria-label={ariaLabel} className={rowClass} onFocus={onFocus}>
        <TabMark selected={value} />
        {items.map((item) => (
          <button key={item.id} type="button" aria-current={item.id === value ? "page" : undefined}
            className={pill(item.id === value)} onClick={() => onChange(item.id)}>{item.label}</button>
        ))}
      </nav>
    );
  }
  return (
    <div ref={rowRef as React.RefObject<HTMLDivElement | null>} data-slot="page-tabs" data-more={edges} role="tablist" aria-label={ariaLabel} className={rowClass} onFocus={onFocus}>
      <TabMark selected={value} />
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button key={item.id} type="button" role="tab" aria-selected={selected}
            id={idPrefix ? `${idPrefix}-tab-${item.id}` : undefined}
            aria-controls={idPrefix && selected ? `${idPrefix}-panel-${item.id}` : undefined}
            className={pill(selected)} onClick={() => onChange(item.id)}>{item.label}</button>
        );
      })}
    </div>
  );
}
