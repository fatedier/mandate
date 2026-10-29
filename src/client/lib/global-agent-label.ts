import type { GlobalAgentDto } from "@shared/api/global-agent";
import { displayGlobalAgentName } from "@shared/global-agent-name";

/** What the page calls the agent above the threads: the name the user gave
 *  it, and until then "Your agent". */
export function globalAgentLabel(agent: Pick<GlobalAgentDto, "name" | "named"> | null): string {
  return agent?.named ? displayGlobalAgentName(agent.name) : "Your agent";
}
