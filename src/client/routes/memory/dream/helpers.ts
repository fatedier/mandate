import type { MemoryDreamActionDto, MemoryDreamRunDto } from "@shared/api-contracts";

export function summarizeRunResult(run: MemoryDreamRunDto): string {
  if (run.status === "failed") return "Failed";
  if (run.status === "running") return "Running…";
  if (run.status === "skipped") return "Skipped";
  const applied = run.appliedCount ?? 0;
  const rejected = run.rejectedCount ?? 0;
  const counts = run.actionCounts;
  const countedActions = counts.update + counts.merge + counts.archive + counts.move + counts.split;
  const total = run.actionCount ?? countedActions + rejected;
  if (total === 0) return run.briefWritten ? "No changes · brief written" : "No changes";
  const parts: string[] = [];
  if (counts.update > 0) parts.push(`${counts.update} updated`);
  if (counts.merge > 0) parts.push(`${counts.merge} merged`);
  if (counts.archive > 0) parts.push(`${counts.archive} archived`);
  if (counts.move > 0) parts.push(`${counts.move} moved`);
  if (counts.split > 0) parts.push(`${counts.split} split`);
  if (parts.length === 0 && applied > 0) parts.push(`${applied} applied`);
  if (rejected > 0) parts.push(`${rejected} rejected`);
  if (run.briefWritten) parts.push("brief written");
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

type ParsedMemoryEntry = { content?: string; kind?: string; type?: string; scope?: string; projectId?: string };

export function parseMemoryEntry(value: unknown): ParsedMemoryEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  return {
    content: typeof obj.content === "string" ? obj.content : undefined,
    kind: typeof obj.kind === "string" ? obj.kind : undefined,
    type: typeof obj.type === "string" ? obj.type : undefined,
    scope: typeof obj.scope === "string" ? obj.scope : undefined,
    projectId: typeof obj.projectId === "string" ? obj.projectId : undefined
  };
}

/** What a split produced: each part's text, and its id where the run recorded it. */
export function splitParts(action: MemoryDreamActionDto): Array<{ id: string | null; text: string }> {
  const record = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null);
  const parts = record(action.source)?.parts;
  const ids = record(record(action.after)?.metadata)?.splitInto;
  const texts = Array.isArray(parts) ? parts.filter((part): part is string => typeof part === "string") : [];
  return texts.map((text, index) => {
    const id = Array.isArray(ids) ? ids[index] : undefined;
    return { text, id: typeof id === "string" ? id : null };
  });
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

/** "2 merged · 1 moved · brief written" — what one partition's run did. */
export function partitionTally(run: MemoryDreamRunDto): string {
  const c = run.actionCounts;
  const parts: string[] = [];
  if (c.update) parts.push(`${c.update} updated`);
  if (c.merge) parts.push(`${c.merge} merged`);
  if (c.archive) parts.push(`${c.archive} archived`);
  if (c.move) parts.push(`${c.move} moved`);
  if (c.split) parts.push(`${c.split} split`);
  if (run.briefWritten) parts.push("brief written");
  if (parts.length > 0) return parts.join(" · ");
  return run.status === "running" ? "working…" : "nothing changed";
}
