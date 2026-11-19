import { useTerminalsStore } from "@/store/terminals";

/** Whether the pane is pinned to the Terminals page's tab row, and the
 *  toggle: a row's icon in All, and the open terminal's ⋯. */
export function usePinToggle(paneId: string, pid: number): { pinned: boolean; onToggle: () => void } {
  const pinned = useTerminalsStore((s) => s.pins.some((p) => p.paneId === paneId && p.pid === pid));
  const onToggle = () => {
    const store = useTerminalsStore.getState();
    void (pinned ? store.unpin(paneId) : store.pin(paneId, pid));
  };
  return { pinned, onToggle };
}
