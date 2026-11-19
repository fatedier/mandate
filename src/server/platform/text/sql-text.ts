/** The value trimmed, or null when it is not a string or is blank. */
export function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Escapes LIKE's wildcards and the backslash itself, for a pattern the query
 *  matches with `escape '\'`. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
