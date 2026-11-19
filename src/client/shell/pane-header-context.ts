import { createContext, useContext } from "react";

/** The context behind the pane-header slot components. Kept in a .ts module
 *  (no JSX) so the hook can live apart from the components in
 *  pane-header-slots.tsx, which keeps that file fast-refresh safe. */

export type SlotNode = HTMLElement | null;

interface PaneHeaderSlots {
  title: SlotNode;
  actions: SlotNode;
  titleClaims: number;
  setTitle: (node: SlotNode) => void;
  setActions: (node: SlotNode) => void;
  claimTitle: () => () => void;
  /** A chat pane's own header (ChatPaneHeader): while one is mounted the
   *  shell's band is not drawn, and a route's title and actions land here. */
  hostTitle: SlotNode;
  hostActions: SlotNode;
  hosts: number;
  setHostTitle: (node: SlotNode) => void;
  setHostActions: (node: SlotNode) => void;
  claimHost: () => () => void;
}

export const PaneHeaderSlotsContext = createContext<PaneHeaderSlots>({
  title: null,
  actions: null,
  titleClaims: 0,
  setTitle: () => {},
  setActions: () => {},
  claimTitle: () => () => {},
  hostTitle: null,
  hostActions: null,
  hosts: 0,
  setHostTitle: () => {},
  setHostActions: () => {},
  claimHost: () => () => {}
});

export function usePaneTitleClaimed(): boolean {
  return useContext(PaneHeaderSlotsContext).titleClaims > 0;
}

/** A chat pane holds the page's header, so the band over a panel beside it
 *  is the panel's: its tab row takes the band's height and drags the window. */
export function usePaneHeaderHosted(): boolean {
  return useContext(PaneHeaderSlotsContext).hosts > 0;
}
