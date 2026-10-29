export const FIELD_SEP = "|||AP|||";

export function parseSeparatedLines(output: string, fields: string[]): Array<Record<string, string>> {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(FIELD_SEP);
      const item: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 1) {
        const field = fields[i];
        if (field) item[field] = parts[i] ?? "";
      }
      return item;
    });
}

/** trimEnd, not `/\s+$/g`: that backtracks quadratically on a long run of
 *  whitespace that does not end the text (256KB of spaces before an "x" took
 *  22s). Both strip the same characters. */
export function tailLines(text: string, count: number) {
  const lines = text.trimEnd().split("\n");
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

export function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** A quoted value's escape takes any character, a line break too: `\\.`
 *  stopped at an escaped newline and left the whole value showing.
 *
 *  The env-var name before API_KEY is matched for at most 64 characters: an
 *  unbounded `[A-Z0-9_]*` (with /i) backtracked quadratically on a long run of
 *  word characters — 32KB took 1.5s, 256KB over a minute. A longer name still
 *  matches on its last 64 characters, so its value is still redacted. */
export function redactSecrets(text: unknown) {
  return String(text)
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(["'`]?(?:[A-Z0-9_]{0,64}API[_-]?KEY|api[_-]?key|token|password|secret)["'`]?\s*[:=]\s*)"(?:\\[\s\S]|[^"\\])*"/gi, "$1[REDACTED]")
    .replace(/(["'`]?(?:[A-Z0-9_]{0,64}API[_-]?KEY|api[_-]?key|token|password|secret)["'`]?\s*[:=]\s*)'(?:\\[\s\S]|[^'\\])*'/gi, "$1[REDACTED]")
    .replace(/(["'`]?(?:[A-Z0-9_]{0,64}API[_-]?KEY|api[_-]?key|token|password|secret)["'`]?\s*[:=]\s*)`(?:\\[\s\S]|[^`\\])*`/gi, "$1[REDACTED]")
    .replace(/(["'`]?(?:api[_-]?key|token|password|secret)["'`]?\s*[:=]\s*)[^\s'"`]+/gi, "$1[REDACTED]")
    .replace(/(["'`]?(?:[A-Z0-9_]{0,64}API[_-]?KEY)["'`]?\s*[:=]\s*)[^\s'"`]+/gi, "$1[REDACTED]")
    .replace(/skey-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[REDACTED]");
}

export function stripAnsi(text: unknown) {
  return String(text ?? "").replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}
