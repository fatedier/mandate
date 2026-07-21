/** The fixed part of the marker, before the digits. Exported because retention.ts
 *  needs a literal it can hand to SQL's instr() to keep already-shortened rows out
 *  of the candidate set, and a second copy of this text over there would be free to
 *  drift from this one. */
export const TRUNCATION_MARKER_PREFIX = "[truncated, original ";

/** The tail written in place of everything past the head. `<N>` is the length of
 *  the ORIGINAL string, so the transcript can still say how much was dropped. */
function marker(originalLength: number): string {
  return `\n${TRUNCATION_MARKER_PREFIX}${originalLength} chars]`;
}

/** Recognises a result this pass has already shortened.
 *
 *  Needed because the truncated value is `head + marker`, which is longer than
 *  the cap — without this check a second pass would truncate its own output, and
 *  a third would truncate that, shrinking the row on every tick forever.
 *
 *  Deliberately anchored at the end and requiring the exact digits-and-words
 *  shape. The two directions are not symmetric, the same way `retention.ts`'s
 *  initial-context predicate is not: failing to recognise a marker only leaves a
 *  row for a later pass, while inventing one truncates content that was already
 *  reduced. A genuine tool output ending in this exact text is therefore skipped
 *  rather than cut twice — a harmless false negative.
 *
 *  Spelled out rather than built from TRUNCATION_MARKER_PREFIX because the
 *  prefix's `[` is a character class in a regex; the two must be edited together.
 *  This one is the authoritative guard — retention.ts's instr() term is only a
 *  cheaper, wider filter in front of it. */
export const TRUNCATION_MARKER_RE = /\n\[truncated, original \d+ chars\]$/;

/**
 * The new `content` JSON for one `agent_messages` row, or `null` when the row
 * needs no change.
 *
 * `null` covers every reason at once — not a tool_result, `result` is not a
 * string, already short enough, already truncated, unparseable — because the
 * caller does the same thing in all five cases: skip the row without a write.
 */
export function truncateToolResultContent(
  content: string,
  headChars: number
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.type !== "tool_result") return null;

  const result = record.result;
  // Strings only. Objects carry 29.7 MB across 34,701 production rows, and
  // shortening one would mean guessing which of its fields holds the payload.
  if (typeof result !== "string") return null;
  if (result.length <= headChars) return null;
  if (TRUNCATION_MARKER_RE.test(result)) return null;

  return JSON.stringify({ ...record, result: result.slice(0, headChars) + marker(result.length) });
}
