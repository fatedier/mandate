import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/** Extension point for pages to inject right-side action buttons into the
 *  global TopBar without coupling TopBar to specific routes. The mechanism is
 *  a React portal: TopBar renders an empty `<TopBarActionsSlot />` whose DOM
 *  node is captured by ref + context; any page can render
 *  `<TopBarActions>...</TopBarActions>` and the children portal into the slot.
 *
 *  Why portal instead of a Zustand store: pages naturally close over their own
 *  state when rendering action JSX inline (e.g. a Dialog with controlled open
 *  state). A store holding stale JSX would capture closures at the wrong time.
 *  Portals re-render in lockstep with the page that owns them. */

type SlotNode = HTMLElement | null;

interface TopBarActionsContextValue {
  node: SlotNode;
  setNode: (n: SlotNode) => void;
}

const TopBarActionsCtx = createContext<TopBarActionsContextValue>({
  node: null,
  setNode: () => {}
});

export function TopBarActionsProvider({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<SlotNode>(null);
  return (
    <TopBarActionsCtx.Provider value={{ node, setNode }}>
      {children}
    </TopBarActionsCtx.Provider>
  );
}

/** Rendered inside TopBar. Holds the DOM target that portaled children land in. */
export function TopBarActionsSlot({ className }: { className?: string }) {
  const { setNode } = useContext(TopBarActionsCtx);
  return (
    <div
      ref={setNode}
      className={cn("flex items-center gap-1.5 shrink-0 empty:hidden", className)}
    />
  );
}

/** Rendered inside any page. Portals its children into the TopBar slot. */
export function TopBarActions({ children }: { children: ReactNode }) {
  const { node } = useContext(TopBarActionsCtx);
  if (!node) return null;
  return createPortal(children, node);
}
