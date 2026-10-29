import { useSnapshotStore } from "@/store/snapshot";

/** Whether the live stream has been down long enough to say so (the snapshot
 *  store keeps the wait, so every header agrees on it). */
export function useReconnecting(): boolean {
  return useSnapshotStore((s) => s.reconnecting);
}
