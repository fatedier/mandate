import type { MemoryDreamRunDto } from "@shared/api-contracts";

export function summarizeRunResult(run: MemoryDreamRunDto): string {
  if (run.status === "failed") return "Failed";
  if (run.status === "running") return "Running…";
  if (run.status === "skipped") return "Skipped";
  const applied = run.appliedCount ?? 0;
  const rejected = run.rejectedCount ?? 0;
  const counts = run.actionCounts;
  const countedActions = counts.keep + counts.update + counts.merge + counts.archive + counts.rescope;
  const total = run.actionCount ?? countedActions + rejected;
  if (total === 0) return "No changes";
  const parts: string[] = [];
  if (counts.update > 0) parts.push(`${counts.update} updated`);
  if (counts.merge > 0) parts.push(`${counts.merge} merged`);
  if (counts.archive > 0) parts.push(`${counts.archive} archived`);
  if (counts.rescope > 0) parts.push(`${counts.rescope} rescoped`);
  if (counts.keep > 0) parts.push(`${counts.keep} kept`);
  if (parts.length === 0 && applied > 0) parts.push(`${applied} applied`);
  if (rejected > 0) parts.push(`${rejected} rejected`);
  return parts.join(" · ");
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * The run's narrative, cleaned up enough to survive one truncated line.
 *
 * Two things ate that line. Every succeeded run's reason begins "finished: ",
 * so a dozen rows opened with the same nine characters before saying anything.
 * And the model writes the raw project/partition UUID into the prose — 36
 * characters naming something the row already shows as a chip beside it, which
 * pushed the actual finding past the ellipsis. UUIDs shorten to their first
 * segment, the git short-SHA convention, which keeps the sentence grammatical.
 *
 * Only the "finished:" prefix is dropped. A "failed:" prefix carries an
 * outcome the row needs.
 */
export function runDetailText(run: MemoryDreamRunDto): string {
  const reason = run.finishReason;
  if (!reason || reason === run.status) return "";
  return reason
    .replace(/^finished:\s*/i, "")
    .replace(UUID, (match) => match.slice(0, 8));
}

type ParsedMemoryEntry = { content?: string; kind?: string; scope?: string };

export function parseMemoryEntry(value: unknown): ParsedMemoryEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  return {
    content: typeof obj.content === "string" ? obj.content : undefined,
    kind: typeof obj.kind === "string" ? obj.kind : undefined,
    scope: typeof obj.scope === "string" ? obj.scope : undefined
  };
}

export function parseActionSource(value: unknown): { candidateScore: number | null; signals: string[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const candidateScore = typeof obj.candidateScore === "number" ? obj.candidateScore : null;
  const signals = Array.isArray(obj.signals)
    ? obj.signals.filter((s): s is string => typeof s === "string")
    : [];
  if (candidateScore == null && signals.length === 0) return null;
  return { candidateScore, signals };
}

export function errorText(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return JSON.stringify(error);
}
