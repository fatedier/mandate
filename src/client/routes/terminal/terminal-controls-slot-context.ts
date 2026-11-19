import { createContext, useContext } from "react";

export interface TerminalControlsSlotState {
  node: HTMLElement | null;
  setNode: (node: HTMLElement | null) => void;
}

/** Set by TerminalControlsSlotProvider (terminal-controls-slot.tsx). */
export const TerminalControlsSlotContext = createContext<TerminalControlsSlotState | null>(null);

/** The row's slot: undefined where there is none (the worker route draws
 *  its terminal's header), null until it is in the page. */
export function useTerminalControlsSlot(): HTMLElement | null | undefined {
  const slot = useContext(TerminalControlsSlotContext);
  return slot ? slot.node : undefined;
}
