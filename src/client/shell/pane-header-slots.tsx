import { useCallback, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PageShownContext } from "@/lib/page-shown";
import { cn } from "@/lib/utils";
import { PaneHeaderSlotsContext as Ctx, type SlotNode } from "@/shell/pane-header-context";
import { ConnectionIndicator } from "@/shell/ConnectionIndicator";
import { useReconnecting } from "@/hooks/useReconnecting";
import { CHAT_COLUMN_MAX_PX, CHAT_GUTTER_CLASS } from "@/routes/window/chat/chat-column";

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
  const [hostTitle, setHostTitle] = useState<SlotNode>(null);
  const [hostActions, setHostActions] = useState<SlotNode>(null);
  const [hosts, setHosts] = useState(0);
  const claimHost = useCallback(() => {
    setHosts((n) => n + 1);
    return () => setHosts((n) => n - 1);
  }, []);
  return (
    <Ctx.Provider value={{ title, actions, titleClaims, setTitle, setActions, claimTitle, hostTitle, hostActions, hosts, setHostTitle, setHostActions, claimHost }}>
      {children}
    </Ctx.Provider>
  );
}

/** Rendered by the shell: the DOM target a route's title lands in. */
export function PaneHeaderTitleSlot({ className }: { className?: string }) {
  const { setTitle, hosts } = useContext(Ctx);
  // A chat pane holds the header (ChatPaneHeader).
  if (hosts > 0) return null;
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
  const { setActions, hosts } = useContext(Ctx);
  // A chat pane holds the header (ChatPaneHeader).
  if (hosts > 0) return null;
  return (
    <div
      ref={setActions}
      data-slot="pane-actions"
      // 8px apart on a touch screen: a 28px icon beside a wider control
      // reaches 8px past its box, and touch areas must not overlap. Two small
      // icons side by side space themselves further.
      className={cn("flex shrink-0 items-center gap-1 pointer-coarse:gap-2 empty:hidden", className)}
    />
  );
}

/** Rendered by a route. Replaces the header's default title while mounted
 *  and shown (a kept page hidden claims nothing: its effects are down). */
export function PaneHeaderTitle({ children }: { children: ReactNode }) {
  const { title, hostTitle, hosts, claimTitle } = useContext(Ctx);
  const shown = useContext(PageShownContext);
  // Claimed only while its page shows: a page kept running hidden
  // (KeptAlivePage) leaves the header its default title.
  useLayoutEffect(() => (shown ? claimTitle() : undefined), [claimTitle, shown]);
  const target = hosts > 0 ? hostTitle : title;
  return shown && target ? createPortal(children, target) : null;
}

/** Rendered by a route. Adds actions to the header while shown. */
export function PaneHeaderActions({ children }: { children: ReactNode }) {
  const { actions, hostActions, hosts } = useContext(Ctx);
  const shown = useContext(PageShownContext);
  const target = hosts > 0 ? hostActions : actions;
  return shown && target ? createPortal(children, target) : null;
}

/**
 * Rendered by a chat page at the top of its chat pane, with a panel beside
 * it (desktop): the page's header, there instead of across the window. Its
 * row is the chat's column (as wide as the transcript at most, centred, in
 * the chat's gutters), so the title and the actions sit over the
 * conversation however the pane is sized, and the band over the panel is
 * the panel's tab row (usePaneHeaderHosted). While it is mounted the shell
 * draws no band of its own; the route's PaneHeaderTitle and PaneHeaderActions
 * land here. It drags the window and says Reconnecting…, as the shell's does.
 */
export function ChatPaneHeader() {
  const { setHostTitle, setHostActions, claimHost } = useContext(Ctx);
  useLayoutEffect(() => claimHost(), [claimHost]);
  const reconnecting = useReconnecting();
  return (
    <header
      data-slot="pane-header"
      data-tauri-drag-region
      // The transcript's gutters and its stable scrollbar gutter (as the
      // composer's box keeps), so the row's edges meet the column's.
      className={cn("flex h-13 shrink-0 items-center overflow-hidden px-(--chat-gutter) [scrollbar-gutter:stable]", CHAT_GUTTER_CLASS)}
    >
      {/* A container: the context pill in the actions sizes itself to it. */}
      <div data-slot="pane-header-row" className="@container mx-auto flex w-full min-w-0 items-center gap-2" style={{ maxWidth: CHAT_COLUMN_MAX_PX }}>
        <div
          ref={setHostTitle}
          data-slot="pane-title"
          className={cn("flex min-w-0 flex-1 items-center gap-2 empty:hidden", reconnecting && "flex-initial shrink-[10000] has-[input]:flex-1")}
        />
        {reconnecting && <ConnectionIndicator />}
        <div
          ref={setHostActions}
          data-slot="pane-actions"
          className={cn("flex shrink-0 items-center gap-1 pointer-coarse:gap-2 empty:hidden", reconnecting && "ml-auto")}
        />
      </div>
    </header>
  );
}
