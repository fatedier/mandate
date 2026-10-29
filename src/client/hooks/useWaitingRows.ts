import { useMemo } from "react";
import { globalAgentLabel } from "@/lib/global-agent-label";
import { waitingRows, type WaitingRow } from "@/lib/waiting-rows";
import { useGlobalAgentStore } from "@/store/global-agent";
import { useThreadStatusStore } from "@/store/thread-status";

/** Everything that waits on the user, most urgent first, as the server
 *  listed it (waitingRows words it): what Home lists, and what the badges
 *  count. */
export function useWaitingRows(): WaitingRow[] {
  const entries = useThreadStatusStore((s) => s.waiting);
  const agent = useGlobalAgentStore((s) => s.agent);
  // Before Your agent's row has loaded, the name the page gives it.
  return useMemo(() => waitingRows(entries, { agentLabel: globalAgentLabel(agent) }), [entries, agent]);
}
