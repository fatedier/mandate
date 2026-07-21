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

export function tailLines(text: string, count: number) {
  const lines = text.replace(/\s+$/g, "").split("\n");
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

export function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function redactSecrets(text: unknown) {
  return String(text)
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(["'`]?(?:[A-Z0-9_]*API[_-]?KEY|api[_-]?key|token|password|secret)["'`]?\s*[:=]\s*)"(?:\\.|[^"\\])*"/gi, "$1[REDACTED]")
    .replace(/(["'`]?(?:[A-Z0-9_]*API[_-]?KEY|api[_-]?key|token|password|secret)["'`]?\s*[:=]\s*)'(?:\\.|[^'\\])*'/gi, "$1[REDACTED]")
    .replace(/(["'`]?(?:[A-Z0-9_]*API[_-]?KEY|api[_-]?key|token|password|secret)["'`]?\s*[:=]\s*)`(?:\\.|[^`\\])*`/gi, "$1[REDACTED]")
    .replace(/(["'`]?(?:api[_-]?key|token|password|secret)["'`]?\s*[:=]\s*)[^\s'"`]+/gi, "$1[REDACTED]")
    .replace(/(["'`]?(?:[A-Z0-9_]*API[_-]?KEY)["'`]?\s*[:=]\s*)[^\s'"`]+/gi, "$1[REDACTED]")
    .replace(/skey-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[REDACTED]");
}

export function stripAnsi(text: unknown) {
  return String(text ?? "").replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}
