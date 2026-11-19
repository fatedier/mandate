import type { LearnedSkillAuthorDto, LearnedSkillSummaryDto } from "@shared/api-contracts";

/** Where a skill applies, as the page names it: "Global" or the project's name. */
export function skillWhere(skill: Pick<LearnedSkillSummaryDto, "scope" | "projectName" | "projectId">): string {
  return skill.scope === "user" ? "Global" : skill.projectName ?? skill.projectId ?? "";
}

/** Who wrote a revision: "Agent in {thread}", "Skill review of {thread}",
 *  "Skill tidy", "60-day rule". The personal agent's conversation is named as the
 *  page names the agent. */
export function skillAuthor(author: LearnedSkillAuthorDto, agentLabel: string): string {
  const thread = author.threadKind === "personal" ? agentLabel : author.threadTitle;
  switch (author.by) {
    case "agent":
      return thread ? `Agent in ${thread}` : "Agent";
    case "review":
      return thread ? `Skill review of ${thread}` : "Skill review";
    case "tidy":
      return "Skill tidy";
    case "rule":
      return "60-day rule";
  }
}
