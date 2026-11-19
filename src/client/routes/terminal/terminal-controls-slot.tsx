import { useContext, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { TerminalControlsSlotContext } from "./terminal-controls-slot-context";

/** Around a tab row and the terminals its tabs show (the Terminals page, the
 *  personal agent's panel): a terminal inside draws no header of its own, and
 *  its controls go to the row's TerminalControlsSlot. A portal, not a store,
 *  as the pane header's slots: the controls close over the terminal's state. */
export function TerminalControlsSlotProvider({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  return <TerminalControlsSlotContext.Provider value={{ node, setNode }}>{children}</TerminalControlsSlotContext.Provider>;
}

/** Where in the tab row the shown terminal's controls land. On a touch
 *  screen 4px more after them: the row puts 8px between its 32px buttons,
 *  whose 44px touch areas reach 6px past each side, so ⋯'s and the next
 *  button's would overlap. */
export function TerminalControlsSlot({ className }: { className?: string }) {
  const slot = useContext(TerminalControlsSlotContext);
  return <div ref={slot?.setNode} data-slot="terminal-controls" className={cn("flex shrink-0 items-center empty:hidden pointer-coarse:mr-1", className)} />;
}
