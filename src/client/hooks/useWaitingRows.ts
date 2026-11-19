import { useMemo } from "react";
import { personalAgentLabel } from "@/lib/personal-agent-label";
import { waitingRows, type WaitingRow } from "@/lib/waiting-rows";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { useThreadStatusStore } from "@/store/thread-status";

/** Everything that waits on the user, most urgent first, as the server
 *  listed it (waitingRows words it): what Home lists, and what the badges
 *  count. */
export function useWaitingRows(): WaitingRow[] {
  const entries = useThreadStatusStore((s) => s.waiting);
  const agent = usePersonalAgentStore((s) => s.agent);
  // Before the personal agent's row has loaded, the name the page gives it.
  return useMemo(() => waitingRows(entries, { agentLabel: personalAgentLabel(agent) }), [entries, agent]);
}
