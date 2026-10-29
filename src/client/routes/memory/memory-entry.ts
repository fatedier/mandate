import type { MemoryEntryDto, MemoryStatsResponse } from "@shared/api-contracts";

/**
 * The names a memory carries in its own metadata.
 *
 * `projectId`/`featureId` on the entry are ids; the readable names sit in
 * `metadata.sourceMetadata`, written when the memory was extracted. The old
 * page showed `feat_Na1sDf3gHj5` because nothing ever looked here — and
 * feature is usually the largest scope in a store.
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
 * cheapest way to make a store of opaque paragraphs auditable.
 */
export function entryReason(entry: MemoryEntryDto): string {
  const metadata = asRecord(entry.metadata);
  return readString(metadata?.extractionReason) ?? "";
}

/** "knowledge · project-3 / fix-login" — for places with no type badge. */
export function entryFacets(
  entry: MemoryEntryDto,
  resolveProject?: (projectId: string) => string | undefined
): string {
  const where = entryLocation(entry, resolveProject);
  return where ? `${entry.type} · ${where}` : entry.type;
}

/** Project names from the stats every memory view already loads: the lookup
 *  for a memory whose extraction recorded no name (a large share of them),
 *  which would otherwise print its project's id. projectNames covers
 *  archived memories too. */
export function projectNameResolver(
  stats: MemoryStatsResponse | null | undefined
): (projectId: string) => string | undefined {
  const names = new Map(Object.entries(stats?.projectNames ?? {}));
  return (projectId) => names.get(projectId);
}

/**
 * Where the memory lives, with no kind in it.
 *
 * Rows that already carry a coloured kind badge were then printing
 * "procedural · project-3 / …" beside it, stating the kind twice and the scope
 * twice. The badge says what it is; this says where it came from.
 */
export function entryLocation(
  entry: MemoryEntryDto,
  resolveProject?: (projectId: string) => string | undefined
): string {
  const { project, feature } = entryPlace(entry, resolveProject);
  if (project && feature) return `${project} / ${feature}`;
  return project ?? feature ?? scopeLabel(entry);
}

/**
 * Where the memory lives now: its project, and the worker it was extracted in
 * while it is still that worker's. The names in its metadata say where it was
 * extracted, and the dream can move it since — to the user's memories or
 * another project, which drops its featureId — so the project's current name
 * comes first (the stats endpoint knows every one), and a recorded feature
 * shows only while the memory keeps its worker and sits with the project it
 * was recorded with.
 */
export function entryPlace(
  entry: MemoryEntryDto,
  resolveProject?: (projectId: string) => string | undefined
): { project?: string; feature?: string } {
  if (entry.scope === "user") return {};
  const names = entryNames(entry);
  const current = entry.projectId ? resolveProject?.(entry.projectId) : undefined;
  const project = current ?? names.project;
  const sameProject = names.project === undefined ? current === undefined : names.project === project;
  return { project, feature: sameProject && entry.featureId ? names.feature : undefined };
}

/** Falls back to the scope word when the entry has no project or feature name. */
function scopeLabel(entry: MemoryEntryDto): string {
  if (entry.scope === "user") return "yours";
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

/** Longest word a two-line preview shows whole, and how much of each end of a
 *  longer one it keeps. */
const PREVIEW_WORD_MAX = 28;
const PREVIEW_WORD_KEEP = 12;
/** Characters as a person sees them: an emoji or a letter with its combining
 *  mark is one, and is never cut through. */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Scripts written without spaces between words: a run of them is a
 *  sentence, not a word, and breaks between characters on its own. */
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** A memory's text for a two-line preview: a word too long to read there (a
 *  hash, a path) is shortened in the middle, so the sentence around it still
 *  shows. A run containing unspaced scripts is left whole (wrapping handles
 *  its width). Only for display; the memory itself is unchanged. */
export function previewText(content: string): string {
  // Words end at whitespace and at zero-width spaces, which separate words
  // without showing a space.
  return content.replace(/[^\s\u200b]+/g, (word) => {
    // UTF-16 units are never fewer than characters: a word this short is
    // short, without segmenting it (a 50-row feed of long memories took
    // ~50ms per render segmenting every word).
    if (word.length <= PREVIEW_WORD_MAX || UNSPACED_SCRIPT.test(word)) return word;
    const chars = Array.from(graphemes.segment(word), (s) => s.segment);
    if (chars.length <= PREVIEW_WORD_MAX) return word;
    return `${chars.slice(0, PREVIEW_WORD_KEEP).join("")}…${chars.slice(-PREVIEW_WORD_KEEP).join("")}`;
  });
}

/** How a memory's source reads on the page. */
export const SOURCE_LABEL: Record<MemoryEntryDto["source"], string> = {
  user: "said by you",
  agent: "agent",
  extraction: "extracted"
};
