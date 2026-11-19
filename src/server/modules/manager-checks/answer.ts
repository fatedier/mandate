/** How sure a decision model must be that the reply is an outcome (done and
 *  cannot together; for the manager stop check, decision and result) before it counts. */
export const DECISION_THRESHOLD = 0.8;

/** A chat model's answer: the text from its
 *  first `{` to its last `}` (a fenced block included), parsed as JSON, its
 *  `status` one of the options. Null when it is not that answer. */
export function readChatChoice<T extends string>(text: string, options: readonly T[]): T | null {
  const status = readJsonAnswer(text)?.status;
  return options.find((option) => option === status) ?? null;
}

/** A chat model's JSON answer: the object from its text's first `{` to its
 *  last `}` (a fenced block included), or null when there is none. */
export function readJsonAnswer(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
