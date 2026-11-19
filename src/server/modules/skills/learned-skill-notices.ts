import type { NotifyRequest } from "../notifications/notification-service.js";
import type { LearnedSkill } from "./learned-skill-store.js";

export type SkillNoticeKind = "learned" | "updated" | "archived" | "restored";

const TITLES: Record<SkillNoticeKind, (name: string) => string> = {
  learned: (name) => `Skill learned: ${name}`,
  updated: (name) => `Skill updated: ${name}`,
  archived: (name) => `Skill archived: ${name}`,
  restored: (name) => `Skill restored: ${name}`
};

/** Where the owner sees a skill's change: its History, at that revision. */
export function skillRevisionLink(skillId: string, revision: number): string {
  return `/memory?view=skills&skill=${encodeURIComponent(skillId)}&revision=${revision}`;
}

/** The news notice for one change to a learned skill: its title says what
 *  happened, its text is the change's reason. */
export function skillChangeNotice(kind: SkillNoticeKind, skill: Pick<LearnedSkill, "id" | "name" | "revision">, reason: string): NotifyRequest {
  return {
    source: "system",
    level: "news",
    matter: { key: `skill:${skill.id}:${skill.revision}`, link: skillRevisionLink(skill.id, skill.revision) },
    title: TITLES[kind](skill.name),
    text: reason
  };
}

/** The 60-day rule's day, as one news notice: how many it archived, their
 *  names, linked to the Skills view. `day` keeps one notice per day. */
export function unusedSkillsArchivedNotice(skills: ReadonlyArray<Pick<LearnedSkill, "id" | "name">>, day: string): NotifyRequest {
  return {
    source: "system",
    level: "news",
    matter: { key: `skills-unused:${day}`, link: "/memory?view=skills" },
    title: skills.length === 1 ? "1 unused skill archived" : `${skills.length} unused skills archived`,
    text: skills.map((s) => s.name).join(", ")
  };
}
