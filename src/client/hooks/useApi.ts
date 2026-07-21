import { useCallback } from "react";
import { readJson } from "@/lib/api-json";
import { useSnapshotStore } from "@/store/snapshot";

interface ApiResponse {
  snapshot?: import("@/store/snapshot").Snapshot;
}

type ApiMethod = "GET" | "POST";

export function useApi() {
  const applyHttpSnapshot = useSnapshotStore((s) => s.applyHttpSnapshot);
  const setBanner = useSnapshotStore((s) => s.setBanner);
  const setConnection = useSnapshotStore((s) => s.setConnection);

  return useCallback(
    async <T extends object>(
      method: ApiMethod,
      path: string,
      body?: unknown
    ): Promise<T | null> => {
      const state = useSnapshotStore.getState();
      const snapshotContext = { generation: state.snapshotGeneration, snapshot: state.snapshot };
      try {
        const response = await fetch(path, {
          method,
          headers: body ? { "content-type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined
        });
        const payload = await readJson<T & ApiResponse>(response);
        if (payload.snapshot) applyHttpSnapshot(payload.snapshot, snapshotContext);
        return payload as T;
      } catch (error) {
        // TypeError covers fetch network failures (server unreachable,
        // offline, CORS). Surface those through ConnectionIndicator instead
        // of as a red banner — the SSE "open" event will clear it on recovery.
        if (error instanceof TypeError) {
          setConnection("error");
          return null;
        }
        const message = error instanceof Error ? error.message : String(error);
        setBanner(message);
        return null;
      }
    },
    [applyHttpSnapshot, setBanner, setConnection]
  );
}
