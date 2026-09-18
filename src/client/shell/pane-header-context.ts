import { createContext, useContext } from "react";

/** The context behind the pane-header slot components. Kept in a .ts module
 *  (no JSX) so the hook can live apart from the components in
 *  pane-header-slots.tsx, which keeps that file fast-refresh safe. */

export type SlotNode = HTMLElement | null;

export interface PaneHeaderSlots {
  title: SlotNode;
  actions: SlotNode;
  titleClaims: number;
  setTitle: (node: SlotNode) => void;
  setActions: (node: SlotNode) => void;
  claimTitle: () => () => void;
}

export const PaneHeaderSlotsContext = createContext<PaneHeaderSlots>({
  title: null,
  actions: null,
  titleClaims: 0,
  setTitle: () => {},
  setActions: () => {},
  claimTitle: () => () => {}
});

export function usePaneTitleClaimed(): boolean {
  return useContext(PaneHeaderSlotsContext).titleClaims > 0;
}
