import { useEffect, useState } from "react";
import { useSnapshotStore } from "@/store/snapshot";

const REVEAL_DELAY_MS = 2000;

export function ConnectionIndicator() {
  const connection = useSnapshotStore((s) => s.connection);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (connection !== "error") {
      setVisible(false);
      return;
    }
    const id = window.setTimeout(() => setVisible(true), REVEAL_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [connection]);

  if (!visible) return null;

  return (
    <div className="fixed inset-x-0 top-2 z-50 flex justify-center pointer-events-none">
      <div className="px-3 py-1 rounded-full bg-panel text-muted-foreground text-xs font-medium border border-border-soft shadow-sm">
        Reconnecting…
      </div>
    </div>
  );
}
