/** The fewest characters, after normalising, that count as the user's words.
 *  "ok" or "yes" is agreement, not a statement a memory can rest on. */
export const MIN_USER_QUOTE_CHARS = 4;

/** Full- and half-width forms alike (NFKC), whitespace collapsed, lower case:
 *  a quote copied from the transcript should match however the model
 *  re-spaced or re-cased it. */
export function normalizeQuoteText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** A message the user wrote, and when. */
export interface UserStatement {
  text: string;
  at: string;
}

/** The latest of the user's messages that holds `quote`, or null when none
 *  does: when they said it, and where. A memory of their words is dated by
 *  it, not by when an agent or an extraction got to it. */
export function quoteStatement<T extends UserStatement>(quote: string, said: readonly T[]): T | null {
  const wanted = normalizeQuoteText(quote);
  if (wanted.length < MIN_USER_QUOTE_CHARS) return null;
  let latest: T | null = null;
  for (const message of said) {
    if (normalizeQuoteText(message.text).includes(wanted) && (latest === null || message.at > latest.at)) latest = message;
  }
  return latest;
}

/** A memory's metadata without when the user said it: what stays when its
 *  text no longer rests on their words. */
export function withoutStatedAt(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!metadata) return null;
  const { statedAt: _statedAt, ...rest } = metadata;
  return rest;
}
