// The quiet notes Your agent reads about its page.

/** How much of a page subagent's last reply its note carries. */
export const PAGE_NOTE_SUMMARY_MAX = 300;

/** What reading sources.json came to, when it was read. */
export type SourcesOutcome = { names: string[] } | { error: string };

/** Counted and cut by characters, so no character is split in two. */
function summaryOf(reply: string | null): string {
  const said = Array.from((reply ?? "").trim());
  return said.length > PAGE_NOTE_SUMMARY_MAX ? `${said.slice(0, PAGE_NOTE_SUMMARY_MAX).join("")}…` : said.join("");
}

/** "…: summary", or "." when the subagent said nothing. */
function withSummary(head: string, reply: string | null): string {
  const summary = summaryOf(reply);
  return summary ? `${head}: ${summary}` : `${head}.`;
}

function sourcesLine(outcome: SourcesOutcome): string {
  return "error" in outcome
    ? `sources.json was not applied: ${outcome.error}. The sources before it keep running.`
    : `Sources: ${outcome.names.length > 0 ? outcome.names.join(", ") : "none"}.`;
}

function joined(head: string, sources: SourcesOutcome | null): string {
  return sources ? `${head}\n${sourcesLine(sources)}` : head;
}

export function subagentPublishedNote(input: { revision: number; title: string; reply: string | null; sources: SourcesOutcome | null }): string {
  return joined(withSummary(`[Page] Version ${input.revision}, from the page subagent “${input.title}”`, input.reply), input.sources);
}

export function subagentUnchangedNote(input: { title: string; reply: string | null; sources: SourcesOutcome | null }): string {
  return joined(withSummary(`[Page] The page subagent “${input.title}” changed nothing`, input.reply), input.sources);
}

export function subagentFailedNote(input: { title: string; reason: string }): string {
  return `[Page] The page subagent “${input.title}” failed: ${input.reason}. The last page stays.`;
}

export function ownEditRefusedNote(reason: string): string {
  return `[Page] Your edit was not published: ${reason}. The last page stays.`;
}

export function ownSourcesRefusedNote(error: string): string {
  return `[Page] ${sourcesLine({ error })}`;
}
