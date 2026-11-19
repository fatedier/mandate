import type { LearnedSkill } from "./learned-skill-store.js";

/** Characters the learned part of an agent's skills list may take. */
export const LEARNED_LIST_BUDGET = 6_000;
/** A description is cut to this when the whole list does not fit. */
const SHORT_DESCRIPTION = 120;

const whereText = (skill: LearnedSkill, projectName: (id: string) => string | null): string =>
  skill.where.scope === "user" ? "global" : `project ${projectName(skill.where.projectId) ?? skill.where.projectId}`;

const line = (skill: LearnedSkill, description: string, projectName: (id: string) => string | null) =>
  `- ${skill.name}: ${description} (${whereText(skill, projectName)})`;

const size = (lines: readonly string[]) => lines.reduce((sum, l) => sum + l.length + 1, 0);

/**
 * The learned skills of an agent's list, one line each, by name (the list
 * is part of the context a window opens with: its order stays put). Past the
 * budget, descriptions are cut first; then the least recently used are left
 * out, and one last line says how many.
 */
export function learnedSkillLines(skills: readonly LearnedSkill[], projectName: (id: string) => string | null, budgetChars = LEARNED_LIST_BUDGET): string[] {
  const byName = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  const whole = byName.map((s) => line(s, s.description, projectName));
  if (size(whole) <= budgetChars) return whole;
  const cut = (s: LearnedSkill) => line(s, s.description.length > SHORT_DESCRIPTION ? `${s.description.slice(0, SHORT_DESCRIPTION - 1)}…` : s.description, projectName);
  const short = byName.map(cut);
  if (size(short) <= budgetChars) return short;
  const recent = [...byName].sort((a, b) => (b.lastUsedAt ?? b.updatedAt).localeCompare(a.lastUsedAt ?? a.updatedAt));
  const kept = new Set<string>();
  const leftOut = (n: number) => `${n} more learned skills are not listed; load one by name if you know it.`;
  let used = 0;
  for (const s of recent) {
    const next = cut(s).length + 1;
    if (used + next + leftOut(recent.length - kept.size - 1).length + 1 > budgetChars) break;
    kept.add(s.name);
    used += next;
  }
  return [...byName.filter((s) => kept.has(s.name)).map(cut), leftOut(byName.length - kept.size)];
}

export { whereText as learnedSkillWhereText };
