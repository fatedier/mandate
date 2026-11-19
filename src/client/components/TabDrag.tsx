import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  DndContext, DragOverlay, MouseSensor, TouchSensor, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragStartEvent, type Modifier
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import { motionAllowed } from "@/lib/motion";
import { ROW_SCROLL_EDGE, carriedX, clipInsets, dropTarget, pointerXOf, rowMayScroll, scrollRange } from "./tab-drag";

/** What a tab of a row that can be reordered is given (PanelTab). */
export interface TabDragProps {
  setNodeRef?: (node: HTMLElement | null) => void;
  style?: CSSProperties;
  listeners?: Record<string, (event: never) => void>;
  /** Its group: tabs are dragged among their own group's only. */
  order?: string;
  /** Carried: its place in the row stays, empty, where it will land. */
  dragging?: boolean;
  /** The copy carried under the pointer, in the page's top layer. */
  lifted?: boolean;
}

interface DragTab { id: string; order?: string }

/** No announcements or instructions: there is no keyboard drag (Space and
 *  Enter open a tab; ⋯'s Move left / Move right are the way without one). */
const QUIET = {
  announcements: { onDragStart: () => undefined, onDragMove: () => undefined, onDragOver: () => undefined, onDragEnd: () => undefined, onDragCancel: () => undefined },
  screenReaderInstructions: { draggable: "" }
};

const DROP = { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" };

/** A tab's slot as laid out in its row (content coordinates): where it
 *  sits, not where it slides to while another is carried. */
interface Slot { id: string; left: number; right: number }

/** The row's tabs of one group, as laid out. */
function slotsOf(row: HTMLElement, order: string): Slot[] {
  return [...row.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.sortOrder === order && el.dataset.dragId !== undefined)
    .map((el) => ({ id: el.dataset.dragId!, left: el.offsetLeft, right: el.offsetLeft + el.offsetWidth }));
}

/** Where the row's content starts on screen, and its window there. */
function frameOf(row: HTMLElement) {
  const box = row.getBoundingClientRect();
  const left = box.left + row.clientLeft;
  return { origin: left - row.scrollLeft, left, right: left + row.clientWidth };
}

/**
 * A row's tabs, each dragged among those of its group: a mouse moves 5px, a
 * finger holds 300ms (moving under 6px) first, so a click, a tap and a swipe
 * stay what they were. The carried copy is drawn in the page's top layer
 * (the row's scroll would cut it, its edge fade see through it), along the
 * row only, over its group's tabs and inside the row's window, cut to that
 * room when it is narrower than the tab. Near an edge the row scrolls under
 * it, as far as its group goes. It drops where the pointer is, onto a tab of
 * the group it was picked up from; a tab that changed group meanwhile (its
 * pin gone on another device) moves nowhere.
 */
export function TabDrag<T extends DragTab>({ tabs, onReorder, children }: {
  tabs: T[];
  onReorder: (id: string, overId: string) => void;
  children: (tab: T, drag: TabDragProps) => ReactNode;
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 6 } })
  );
  const [carried, setCarried] = useState<string | null>(null);
  // What the carry began with: the row, the group, where the row was scrolled.
  const carry = useRef<{ row: HTMLElement; order: string; scroll: number; pad: number } | null>(null);
  // Where the pointer is, from the press to the release, read before
  // dnd-kit reads the event: which edge a carried tab is near, which tab
  // slides aside, and where it is let go. The one source for all three (the
  // move that starts a drag may already reach the next tab, and dnd-kit's
  // own coordinates and `over` stay behind then).
  const pointerX = useRef<number | null>(null);
  useEffect(() => {
    const kinds = ["mousedown", "mousemove", "mouseup", "touchstart", "touchmove", "touchend"] as const;
    const track = (e: Event) => {
      const x = pointerXOf(e as MouseEvent & TouchEvent);
      if (x !== null) pointerX.current = x;
    };
    for (const kind of kinds) window.addEventListener(kind, track, true);
    return () => { for (const kind of kinds) window.removeEventListener(kind, track, true); };
  }, []);

  /** The carried group's room on screen: its slots inside the row's window. */
  const room = () => {
    const c = carry.current;
    if (!c) return null;
    const slots = slotsOf(c.row, c.order);
    if (slots.length === 0) return null;
    const frame = frameOf(c.row);
    const group = { left: frame.origin + Math.min(...slots.map((x) => x.left)), right: frame.origin + Math.max(...slots.map((x) => x.right)) };
    return { slots, frame, group };
  };
  // The copy, cut to the room its group has in the row, read once laid out.
  const clip = useRef(0);
  const clipCarried = () => {
    cancelAnimationFrame(clip.current);
    clip.current = requestAnimationFrame(() => {
      const copy = document.querySelector<HTMLElement>("[data-carried]");
      const r = room();
      if (!copy || !r) return;
      const box = copy.getBoundingClientRect();
      const cut = clipInsets(box, { left: Math.max(r.group.left, r.frame.left), right: Math.min(r.group.right, r.frame.right) });
      copy.style.clipPath = cut.left > 0 || cut.right > 0 ? `inset(0 ${cut.right}px 0 ${cut.left}px)` : "";
    });
  };

  useEffect(() => {
    const c = carry.current;
    if (!carried || !c) return;
    // dnd-kit asks canScroll as it starts scrolling, not at every step: held
    // still past an edge, the row went on past its group's end. Kept within
    // it; and the group's room changed, so the copy's cut too.
    const scrolled = () => {
      const slots = slotsOf(c.row, c.order);
      if (slots.length > 0) {
        const range = scrollRange(c.scroll, { left: Math.min(...slots.map((x) => x.left)), right: Math.max(...slots.map((x) => x.right)) }, c.row.clientWidth, c.pad);
        const next = Math.min(range.max, Math.max(range.min, c.row.scrollLeft));
        if (next !== c.row.scrollLeft) c.row.scrollLeft = next;
      }
      clipCarried();
    };
    c.row.addEventListener("scroll", scrolled, { passive: true });
    // Escape puts the tab back (dnd-kit's own handler); taken here, so the
    // page's Escape (a maximized pane given back) leaves it alone.
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") event.preventDefault(); };
    window.addEventListener("keydown", escape, true);
    // Cut from the first frame: picked up and held still, it has not moved.
    clipCarried();
    return () => {
      cancelAnimationFrame(clip.current);
      c.row.removeEventListener("scroll", scrolled);
      window.removeEventListener("keydown", escape, true);
    };
    // clipCarried reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carried]);

  const orderOf = (id: string | number) => tabs.find((t) => t.id === id)?.order;
  /** The tab of the group it was picked up from, in sight in the row,
   *  under (or nearest) the pointer at `x`: where it drops. */
  const targetAt = (x: number | null) => {
    const r = room();
    if (!r || x === null) return null;
    return dropTarget(x, r.slots.map((slot) => ({ id: slot.id, left: r.frame.origin + slot.left, right: r.frame.origin + slot.right })), r.frame);
  };
  // The same place, for the tabs that slide aside meanwhile.
  const collision: CollisionDetection = (args) => {
    const id = targetAt(pointerX.current ?? args.pointerCoordinates?.x ?? null);
    const container = args.droppableContainers.find((c) => c.id === id);
    return id === null || !container ? [] : [{ id, data: { droppableContainer: container, value: 0 } }];
  };
  const keep: Modifier = ({ transform, activeNodeRect }) => {
    const r = room();
    if (!r || !activeNodeRect) return { ...transform, y: 0 };
    return {
      ...transform,
      y: 0,
      x: carriedX(transform.x, { nodeLeft: activeNodeRect.left, width: activeNodeRect.width, groupLeft: r.group.left, groupRight: r.group.right, rowLeft: r.frame.left, rowRight: r.frame.right })
    };
  };
  const canScroll = (element: Element) => {
    const r = room();
    if (!carry.current || element !== carry.current.row) return true;
    const x = pointerX.current;
    if (!r || x === null) return false;
    return rowMayScroll(x, r.frame, r.group);
  };
  const start = (event: DragStartEvent) => {
    const id = String(event.active.id);
    setGlides(true);
    // The row of the tab pressed: another row may draw a tab of the same id
    // (a canvas open beside the personal agent and in a thread's panel, the
    // page kept while another shows).
    const pressed = event.activatorEvent.target instanceof Element ? event.activatorEvent.target.closest<HTMLElement>("[data-drag-id]") : null;
    const row = (pressed?.dataset.dragId === id ? pressed : [...document.querySelectorAll<HTMLElement>("[data-drag-id]")].find((el) => el.dataset.dragId === id))?.parentElement;
    const order = orderOf(id);
    carry.current = row && order !== undefined
      ? { row, order, scroll: row.scrollLeft, pad: Number.parseFloat(getComputedStyle(row).paddingLeft) || 0 }
      : null;
    setCarried(id);
  };
  // The copy glides into its place only when it and that place are both in
  // sight in the row: a glide to or from behind the header's controls would
  // cross them (a cut cannot keep up with a moving copy), so it just lands.
  const [glides, setGlides] = useState(true);
  const landsInSight = (id: string, over: string | null) => {
    const r = room();
    const copy = document.querySelector<HTMLElement>("[data-carried]")?.getBoundingClientRect();
    if (!r || !copy) return false;
    const inSight = (left: number, right: number) => left >= r.frame.left - 0.5 && right <= r.frame.right + 0.5;
    const from = r.slots.findIndex((x) => x.id === id);
    const to = over === null ? from : r.slots.findIndex((x) => x.id === over);
    const own = r.slots[from];
    const place = r.slots[to];
    if (!own || !place) return false;
    // Taking the place of a tab after it, it ends at that tab's right; of one
    // before it, it starts at that tab's left.
    const width = own.right - own.left;
    const [left, right] = to > from ? [place.right - width, place.right] : [place.left, place.left + width];
    return inSight(copy.left, copy.right) && inSight(r.frame.origin + left, r.frame.origin + right);
  };
  // Every way a drag ends (let go, or Escape putting it back) goes through
  // here, so the glide is always decided the same way. The group it was
  // carried in, if any.
  const finish = (id: string, over: string | null) => {
    setGlides(landsInSight(id, over === id ? null : over));
    const order = carry.current?.order;
    carry.current = null;
    setCarried(null);
    return order;
  };
  const end = (event: DragEndEvent) => {
    // Where it is let go, from the slots in sight, not dnd-kit's `over`.
    const id = String(event.active.id);
    const over = targetAt(pointerX.current);
    const order = finish(id, over);
    // Gone meanwhile (its pane closed), or moved to the other group (its pin
    // gone on another device): no move.
    if (over === null || over === id || order === undefined || orderOf(id) !== order) return;
    if (orderOf(over) === order) onReorder(id, over);
  };
  const lifted = carried === null ? undefined : tabs.find((t) => t.id === carried);
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={start}
      onDragMove={clipCarried}
      onDragEnd={end}
      onDragCancel={(event) => { finish(String(event.active.id), null); }}
      autoScroll={{ canScroll, threshold: { x: ROW_SCROLL_EDGE, y: 0 } }}
      accessibility={QUIET}
    >
      <SortableContext items={tabs.filter((t) => t.order !== undefined).map((t) => t.id)} strategy={horizontalListSortingStrategy}>
        {tabs.map((tab) => <SortableTab key={tab.id} tab={tab} carried={carried === tab.id}>{children}</SortableTab>)}
      </SortableContext>
      {createPortal(
        <DragOverlay modifiers={[keep]} dropAnimation={glides && motionAllowed() ? DROP : null} zIndex={60}>
          {lifted ? children(lifted, { order: lifted.order, lifted: true }) : null}
        </DragOverlay>,
        document.body
      )}
    </DndContext>
  );
}

function SortableTab<T extends DragTab>({ tab, carried, children }: {
  tab: T;
  carried: boolean;
  children: (tab: T, drag: TabDragProps) => ReactNode;
}) {
  const sortable = useSortable({ id: tab.id, disabled: tab.order === undefined });
  return (
    <>
      {children(tab, {
        setNodeRef: (node) => {
          sortable.setNodeRef(node);
          if (node) node.dataset.dragId = tab.id;
        },
        style: { transform: DndCSS.Translate.toString(sortable.transform), transition: sortable.transition },
        listeners: tab.order === undefined ? undefined : (sortable.listeners as TabDragProps["listeners"]),
        order: tab.order,
        dragging: carried
      })}
    </>
  );
}
