import type { MemoryEntryDto } from "@shared/api-contracts";

/**
 * The names a memory carries in its own metadata.
 *
 * `projectId`/`featureId` on the entry are ids; the readable names sit in
 * `metadata.sourceMetadata`, written when the memory was extracted. The old
 * page showed `feat_02YWP4TTkkI` because nothing ever looked here — and
 * feature is the largest scope in the store.
 */
export function entryNames(entry: MemoryEntryDto): { project?: string; feature?: string } {
  const source = sourceMetadata(entry);
  return {
    project: readString(source?.projectName),
    feature: readString(source?.featureName)
  };
}

/**
 * Why this memory was kept, in the extractor's own words. Surfacing it is the
 * cheapest way to make a store of 142 opaque paragraphs auditable.
 */
export function entryReason(entry: MemoryEntryDto): string {
  const metadata = asRecord(entry.metadata);
  return readString(metadata?.extractionReason) ?? "";
}

/** "semantic · frp / upgrade-eslint-10" — for places with no kind badge. */
export function entryFacets(entry: MemoryEntryDto): string {
  const where = entryLocation(entry);
  return where ? `${entry.kind} · ${where}` : entry.kind;
}

/**
 * Where the memory lives, with no kind in it.
 *
 * Rows that already carry a coloured kind badge were then printing
 * "procedural · console / …" beside it, stating the kind twice and the scope
 * twice. The badge says what it is; this says where it came from.
 */
export function entryLocation(
  entry: MemoryEntryDto,
  resolveProject?: (projectId: string) => string | undefined
): string {
  const names = entryNames(entry);
  // A memory's own metadata carries the name only if it was recorded at
  // extraction time; the stats endpoint knows every project's name regardless,
  // so an unnamed entry still resolves rather than printing a bare UUID.
  const project =
    names.project ?? (entry.projectId ? resolveProject?.(entry.projectId) : undefined);
  if (project && names.feature) return `${project} / ${names.feature}`;
  return project ?? names.feature ?? scopeLabel(entry);
}

/**
 * The usage fact worth printing on a row, given what the current filter has
 * already fixed.
 *
 * Under "never recalled" every row would otherwise read "never recalled" —
 * a column of the one thing the filter guarantees. Suppressing it leaves the
 * age, which is what actually differs. Under "recalled but never used" the
 * recall count is the whole point and varies wildly, so it stays.
 */
export function usageSummary(
  entry: MemoryEntryDto,
  activeFilter: string
): { text: string; attention: boolean } | null {
  if (entry.useCount > 0) return { text: `used ${entry.useCount}×`, attention: false };
  if (entry.recallCount > 0) {
    return { text: `${entry.recallCount} recalls, never used`, attention: true };
  }
  // Never recalled: nothing numeric distinguishes these rows, so under the
  // filter that selects exactly them the phrase is pure repetition.
  return activeFilter === "untouched" ? null : { text: "never recalled", attention: false };
}

/** Falls back to the scope word when the entry has no project or feature name. */
function scopeLabel(entry: MemoryEntryDto): string {
  if (entry.scope === "user" || entry.scope === "global") return entry.scope;
  // A project- or feature-scoped memory whose name is recorded nowhere — show
  // a short id rather than claiming a scope the reader can't act on. A full
  // 36-character UUID would crowd out the row's actual content.
  const id = entry.featureId ?? entry.projectId;
  return id ? shortId(id) : entry.scope;
}

function shortId(id: string): string {
  return /^[0-9a-f-]{32,}$/i.test(id) ? id.slice(0, 8) : id;
}

function sourceMetadata(entry: MemoryEntryDto): Record<string, unknown> | null {
  return asRecord(asRecord(entry.metadata)?.sourceMetadata);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
