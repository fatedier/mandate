/** How sure a decision model must be that the reply is an outcome (done and
 *  cannot together; for the manager stop check, decision and result) before it counts. */
export const DECISION_THRESHOLD = 0.8;

/** A chat model's answer: the text from its
 *  first `{` to its last `}` (a fenced block included), parsed as JSON, its
 *  `status` one of the options. Null when it is not that answer. */
export function readChatChoice<T extends string>(text: string, options: readonly T[]): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    const status = parsed && typeof parsed === "object" ? (parsed as { status?: unknown }).status : undefined;
    return options.find((option) => option === status) ?? null;
  } catch {
    return null;
  }
}
