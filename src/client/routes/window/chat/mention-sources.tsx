import { useMemo, type ReactNode } from "react";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useThreadDots } from "@/hooks/useThreadDots";
import { ThreadStateMark } from "@/shell/ThreadStateMark";
import { formatRelativeTime } from "@/lib/format";
import { threadHref } from "@/lib/feature-href";
import { mentionLabel, type Mention } from "@shared/mentions";

/** One thing an @ can name, as the composer's list shows it. */
export interface MentionOption {
  mention: Mention;
  content: ReactNode;
}

/** A kind of thing an @ can name: its group in the list, what it offers for
 *  a query, and where a sent mention of it leads. Both are hooks, called on
 *  every render of whatever shows them; with no query (no @ being typed) the
 *  options hook offers nothing and follows no store. A kind added later is
 *  one source here (and its entry on the server). */
export interface MentionSource {
  kind: string;
  heading: string;
  useOptions(query: string | null, excludeId: string | null): MentionOption[];
  useHref(id: string): string | null;
}

const NO_THREADS: ReadonlyMap<string, never> = new Map<string, never>();

/** Open threads (the store's list holds no archived one) whose title holds
 *  the query, the newest activity first, each with the sidebar's state
 *  mark; never the conversation typed in. Its label is the title on one
 *  line, as the server keeps it. */
function useThreadMentionOptions(query: string | null, excludeId: string | null): MentionOption[] {
  const threads = useManagerThreadsStore((s) => (query === null ? NO_THREADS : s.threads));
  const dots = useThreadDots(query !== null);
  return useMemo(() => {
    const needle = (query ?? "").toLowerCase();
    return [...threads.values()]
      .filter((t) => t.id !== excludeId && t.title.toLowerCase().includes(needle))
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
      .map((t) => ({
        mention: { kind: "thread", id: t.id, label: mentionLabel(t.title) },
        content: (
          <>
            <ThreadStateMark dot={dots.get(t.id) ?? "idle"} />
            <span data-slot="mention-title" className="min-w-0 flex-1 truncate text-xs text-foreground">{t.title}</span>
            <span className="shrink-0 text-2xs text-faint tabular-nums">{formatRelativeTime(t.lastActivityAt)}</span>
          </>
        )
      }));
  }, [threads, dots, query, excludeId]);
}

/** A thread open or archived leads to its page; one gone leads nowhere. */
function useThreadMentionHref(id: string): string | null {
  const known = useManagerThreadsStore((s) => s.threads.has(id) || s.archived.some((t) => t.id === id));
  return known ? threadHref(id) : null;
}

export const MENTION_SOURCES: readonly MentionSource[] = [
  { kind: "thread", heading: "Threads", useOptions: useThreadMentionOptions, useHref: useThreadMentionHref }
];

export function mentionSourceOf(kind: string): MentionSource | undefined {
  return MENTION_SOURCES.find((source) => source.kind === kind);
}

/** The list's groups for an @ being typed (none while `query` is null): one
 *  group per source with something to offer. Every source's options hook
 *  runs on every render, in the list's fixed order. */
export function useMentionGroups(query: string | null, excludeId: string | null): Array<{ heading: string; options: MentionOption[] }> {
  const offered = MENTION_SOURCES.map((source) => ({
    heading: source.heading,
    // MENTION_SOURCES is a constant list: the same hooks run in the same order on every render.
    options: source.useOptions(query, excludeId)
  }));
  return offered.filter((group) => group.options.length > 0);
}

/** An option's key in the list: its kind and id. */
export const mentionOptionKey = (mention: Mention) => `${mention.kind}-${mention.id}`;
