import { useState } from "react";
import {X} from "lucide-react";
import type { SnapshotWindow } from "@/lib/snapshot-types";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api-paths";
import type { WindowInspectRequest, WindowInspectResponse } from "@shared/api-contracts";
import { RefreshButton } from "@/components/RefreshButton";

interface WindowPageActionsProps {
  window: SnapshotWindow;
  onClose: () => void;
  /** Overflow menu, rendered between Refresh and Close. */
  children?: React.ReactNode;
}

export function WindowPageActions({ window, onClose, children }: WindowPageActionsProps) {
  const [refreshing, setRefreshing] = useState(false);
  const request = useApi();

  const refreshPanes = async () => {
    if (!window.windowId) return;
    setRefreshing(true);
    try {
      const body = { windowId: window.windowId } satisfies WindowInspectRequest;
      await request<WindowInspectResponse>("POST", api.windowInspect, body);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="flex items-center gap-1 shrink-0">
      {/* Icon-only. The label used to make this the header's one labelled
          action, on the reading that it was the thing you came here to do. It
          is not: the snapshot streams in over SSE, so this is a fallback for
          when it looks stale — and it used to be worse than a fallback, since
          it also pinned the window into an add-only forced-poll set.
          `aria-label` is now load-bearing: the text was the accessible name. */}
      <RefreshButton scope="local" size="icon" what="panes" refreshing={refreshing} onRefresh={refreshPanes} />
      {children}
      {/* Close is navigation, not an action — ghost like the others, so the
          header reads as three quiet affordances rather than one shouted one. */}
      <Button variant="ghost" size="icon" aria-label="Close drawer" onClick={onClose} className="text-chrome">
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
