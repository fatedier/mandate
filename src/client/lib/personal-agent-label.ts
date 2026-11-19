import type { PersonalAgentDto } from "@shared/api/personal-agent";
import { displayPersonalAgentName } from "@shared/personal-agent-name";

/** What the page calls the agent above the threads: the name the user gave
 *  it, and until then "Personal agent". */
export function personalAgentLabel(agent: Pick<PersonalAgentDto, "name" | "named"> | null): string {
  return agent?.named ? displayPersonalAgentName(agent.name) : "Personal agent";
}
