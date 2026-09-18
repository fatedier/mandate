import { useCallback, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { PaneHeaderSlotsContext as Ctx, type SlotNode } from "@/shell/pane-header-context";

/** Routes put their title and actions into the left pane's header through
 *  portals. Portals, not a store: a page's action JSX closes over its own
 *  state (a Dialog with controlled `open`), and a store holding stale JSX
 *  would capture those closures at the wrong time. Portals re-render in
 *  lockstep with the page that owns them.
 *
 *  A route that renders <PaneHeaderTitle> also CLAIMS the title, so the
 *  header can hide its breadcrumb-derived default. The context and the
 *  `usePaneTitleClaimed` hook live in pane-header-context.ts. */

export function PaneHeaderSlotsProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<SlotNode>(null);
  const [actions, setActions] = useState<SlotNode>(null);
  const [titleClaims, setTitleClaims] = useState(0);
  const claimTitle = useCallback(() => {
    setTitleClaims((n) => n + 1);
    return () => setTitleClaims((n) => n - 1);
  }, []);
  return (
    <Ctx.Provider value={{ title, actions, titleClaims, setTitle, setActions, claimTitle }}>
      {children}
    </Ctx.Provider>
  );
}

/** Rendered by the shell: the DOM target a route's title lands in. */
export function PaneHeaderTitleSlot({ className }: { className?: string }) {
  const { setTitle } = useContext(Ctx);
  return (
    <div
      ref={setTitle}
      data-slot="pane-title"
      className={cn("flex min-w-0 flex-1 items-center gap-2 empty:hidden", className)}
    />
  );
}

/** Rendered by the shell: the DOM target a route's actions land in. */
export function PaneHeaderActionsSlot({ className }: { className?: string }) {
  const { setActions } = useContext(Ctx);
  return (
    <div
      ref={setActions}
      data-slot="pane-actions"
      className={cn("flex shrink-0 items-center gap-1 empty:hidden", className)}
    />
  );
}

/** Rendered by a route. Replaces the header's default title while mounted. */
export function PaneHeaderTitle({ children }: { children: ReactNode }) {
  const { title, claimTitle } = useContext(Ctx);
  useLayoutEffect(() => claimTitle(), [claimTitle]);
  return title ? createPortal(children, title) : null;
}

/** Rendered by a route. Adds actions to the header. */
export function PaneHeaderActions({ children }: { children: ReactNode }) {
  const { actions } = useContext(Ctx);
  return actions ? createPortal(children, actions) : null;
}
