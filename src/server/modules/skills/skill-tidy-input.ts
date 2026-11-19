/** One learned skill as the tidy's opening lists it. */
export interface TidyLine {
  name: string;
  description: string;
  /** "global" or "project {name}". */
  where: string;
  revision: number;
  uses30: number;
  uses90: number;
  lastUsedAt: string | null;
  lastChangedAt: string;
  lines: number;
}

/** How long the opening may be before its descriptions are cut. */
export const TIDY_OPENING_BUDGET_CHARS = 24_000;
/** A description is cut to this when the opening does not fit. */
const SHORT_DESCRIPTION = 120;

const HEAD = "A tidy of the learned skills. One line each: name — description (where; revision; uses in 30 and 90 days; last used; last changed; lines).";

const day = (iso: string) => iso.slice(0, 10);

const lineOf = (s: TidyLine, description: string) =>
  `- ${s.name} — ${description} (${s.where}; revision ${s.revision}; ${s.uses30} and ${s.uses90} uses; last used ${s.lastUsedAt ? day(s.lastUsedAt) : "never"}; last changed ${day(s.lastChangedAt)}; ${s.lines} lines)`;

/** The one message a tidy starts from: every learned skill, available ones
 *  first, one line each; the bodies are read with `read_skill`. Past the
 *  budget, descriptions are cut. */
export function renderTidyOpening(input: { available: readonly TidyLine[]; archived: readonly TidyLine[]; budgetChars?: number }): string {
  const render = (describe: (s: TidyLine) => string) => {
    const part = (title: string, skills: readonly TidyLine[]) => (skills.length ? [`${title}:`, ...skills.map((s) => lineOf(s, describe(s)))] : [`${title}: none.`]);
    return [HEAD, ...part("Available", input.available), ...part("Archived", input.archived)].join("\n");
  };
  const whole = render((s) => s.description);
  if (whole.length <= (input.budgetChars ?? TIDY_OPENING_BUDGET_CHARS)) return whole;
  return render((s) => (s.description.length > SHORT_DESCRIPTION ? `${s.description.slice(0, SHORT_DESCRIPTION - 1)}…` : s.description));
}
