import { Sheet, SheetContent } from "@/components/ui/sheet";
import { VisuallyHidden } from "radix-ui";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useAgentChatStore } from "@/store/agent-chat";
import { useVisualViewport } from "@/hooks/useKeyboardOffset";
import { AgentChatPanel } from "./AgentChatPanel";

/** Mobile chat surface: a fullscreen modal sheet. It ignores `drawerMode` on
 *  purpose — that switch is desktop-only (the control setting "fullscreen" is
 *  `hidden md:`), so on a phone it would pin the sheet to a partial height
 *  forever. Modal because a fullscreen sheet covers the page behind
 *  completely: leaving it focusable would let Tab and a screen reader walk
 *  into content nobody can see. Keyboard-offset behavior is preserved. */
export function MobileChatSheet() {
  const drawerOpen = useAgentChatStore((s) => s.drawerOpen);
  const drawerScope = useAgentChatStore((s) => s.drawerScope);
  const closeDrawer = useAgentChatStore((s) => s.closeDrawer);
  const { keyboardOffset, keyboardHeight, visualHeight } = useVisualViewport();
  const keyboardOpen = keyboardHeight > 50;

  const handleClose = () => {
    // Mobile: closing the sheet leaves voice running so MobileVoicePill takes
    // over. Voice ends only via the pill's stop button.
    closeDrawer();
  };

  // Keyboard up: sit exactly over the visual viewport. `bottom` + `height`
  // with NO `top` is load-bearing, not a style choice. keyboardOffset is
  // `innerHeight - vv.height - vv.offsetTop`, i.e. the gap from the visual
  // viewport's bottom edge to the layout viewport's bottom edge, so solving
  // the top edge from it lands the sheet at vv.offsetTop for *any* offset.
  // Adding `top` here would over-constrain the box; CSS then drops `bottom`
  // (verified in Chromium, and CSS 2.1 §10.6.4), the sheet would anchor to the
  // layout viewport's top, and iOS Safari — which offsets the visual viewport
  // when the keyboard opens and does not honor interactive-widget — would show
  // it displaced upward by exactly offsetTop. Do not "simplify" this branch to
  // match the one below.
  // Keyboard down: top-anchored, one viewport tall. No `bottom` here — with
  // `top` and `height` both set it would be ignored anyway.
  // > 50px threshold avoids reacting to small URL-bar reflows on iOS Safari.
  const sheetStyle: React.CSSProperties = keyboardOpen && visualHeight
    ? {
        bottom: keyboardOffset > 50 ? `${keyboardOffset}px` : "0",
        height: `${visualHeight}px`
      }
    : { top: "0", height: "100dvh" };

  if (!drawerScope) return null;

  return (
    <Sheet
      open={drawerOpen}
      onOpenChange={(o) => { if (!o) handleClose(); }}
    >
      {/* pt-[env(safe-area-inset-top)]: the sheet now covers TopBar, which was
          the only thing paying the top inset (index.html sets
          viewport-fit=cover), so without it the chat header sits under the
          status bar / notch. box-sizing is border-box, so the padding shrinks
          the content box instead of overflowing the explicit height in
          sheetStyle. The bottom inset is already paid by ChatInput.

          Deliberately a class, not the inline `style={{ paddingTop: ... }}`
          spelling every other env() call site here uses (TopBar, ChatInput,
          VoiceControlBar, MobileVoicePill). Do not "normalize" it to match
          them: happy-dom's CSS parser drops any inline declaration containing
          env() — bare, with a fallback, or wrapped in max() — so an inline
          version is invisible to the tests and deleting it would stay green.
          The class name is the only form tests/mobile-chat-sheet.test.tsx can
          assert on, and that assertion is what catches its removal. Nothing
          overrides it: `p-0` is a shorthand, and Tailwind sorts longhand
          utilities after shorthands, so pt-* wins. */}
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="flex flex-col p-0 pt-[env(safe-area-inset-top)] gap-0 overflow-hidden rounded-none border-t-0"
        style={sheetStyle}
        aria-describedby={undefined}
      >
        <VisuallyHidden.Root>
          <DialogPrimitive.Title>Agent chat</DialogPrimitive.Title>
        </VisuallyHidden.Root>
        <AgentChatPanel />
      </SheetContent>
    </Sheet>
  );
}
