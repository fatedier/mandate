import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { useTaskBoardStore } from "@/store/task-board";
import { TaskStatusIcon } from "@/routes/task-board/TaskStatusIcon";
import { taskHref } from "@/routes/task-board/task-links";
import { isOpen } from "@/routes/task-board/task-format";
import { useOpenTask } from "@/routes/task-board/task-open";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { useCanvasTitles } from "@/store/canvas-titles";
import { useThreadDots } from "@/hooks/useThreadDots";
import { ThreadStateMark } from "@/shell/ThreadStateMark";
import { formatRelativeTime } from "@/lib/format";
import { threadHref } from "@/lib/worker-href";
import { api } from "@/lib/api-paths";
import { personalAgentLabel } from "@/lib/personal-agent-label";
import { useOpenCanvas } from "@/routes/canvas/canvas-opener";
import { mentionLabel, type Mention } from "@shared/mentions";
import type { CanvasMentionsResponse } from "@shared/api-contracts";
import { CanvasIcon, CanvasOption, MentionTitle } from "./MentionCanvas";
import { usePinyinMatch } from "@/lib/pinyin";
import { titleHit } from "@shared/title-match";

/** One thing an @ can name, as the composer's list shows it. */
export interface MentionOption {
  mention: Mention;
  content: ReactNode;
}

/** What a sent mention's tag does: where it leads, how a click opens it
 *  (left to the link when absent), and the mark before its words ("@" when
 *  absent). */
export interface MentionTagTarget {
  href: string;
  open?: () => void;
  icon?: ReactNode;
}

/** A kind of thing an @ can name: its group in the list, what it offers for
 *  a query (at most `limit`, how many there are in all, and `ready: false`
 *  while its answer for that query is still on its way), and what a sent
 *  mention of it does (null: it is gone, the tag is words). Both are hooks,
 *  called on every render of whatever shows them; with no query (no @ being
 *  typed) the options hook offers nothing and follows no store. A kind added
 *  later is one source here (and its entry on the server). */
export interface MentionSource {
  kind: string;
  heading: string;
  useOptions(query: string | null, excludeId: string | null, limit: number, context: MentionContext): { options: MentionOption[]; total: number; ready?: boolean };
  useTag(id: string): MentionTagTarget | null;
}

/** Where the @ is typed: a task's comment box offers the personal agent too. */
export interface MentionContext {
  agent: boolean;
}

/** How many of each kind a bare @ shows, and how many once something is typed. */
const BARE_LIMIT = 4;
const TYPED_LIMIT = 8;
/** How long the list keeps what it showed while a group's answer for what was
 *  typed is on its way: the list changes once per keystroke, not twice. */
const SETTLE_MS = 300;

const NO_THREADS: ReadonlyMap<string, never> = new Map<string, never>();
const NOTHING = { options: [], total: 0 };

/** Open threads (the store's list holds no archived one) whose title answers
 *  the query (titleHit: holding it, or a Chinese title by its pinyin), those
 *  holding it first, each part by newest activity, each with the sidebar's
 *  state mark and what answered marked; never the conversation typed in. Its
 *  label is the title on one line, as the server keeps it. */
function useThreadMentionOptions(query: string | null, excludeId: string | null, limit: number) {
  const threads = useManagerThreadsStore((s) => (query === null ? NO_THREADS : s.threads));
  const dots = useThreadDots(query !== null);
  const pinyin = usePinyinMatch(query !== null);
  return useMemo(() => {
    if (query === null) return NOTHING;
    const matching = [...threads.values()]
      .filter((t) => t.id !== excludeId)
      .flatMap((t) => {
        const hit = titleHit(t.title, query, pinyin);
        return hit ? [{ t, hit }] : [];
      })
      .sort((a, b) => a.hit.rank - b.hit.rank || b.t.lastActivityAt.localeCompare(a.t.lastActivityAt));
    return {
      total: matching.length,
      options: matching.slice(0, limit).map(({ t, hit }) => ({
        mention: { kind: "thread", id: t.id, label: mentionLabel(t.title) },
        content: (
          <>
            <ThreadStateMark dot={dots.get(t.id) ?? "idle"} />
            <MentionTitle title={t.title} marks={hit.marks} />
            <span data-slot="mention-meta" className="shrink-0 text-2xs text-faint tabular-nums">{formatRelativeTime(t.lastActivityAt)}</span>
          </>
        )
      }))
    };
  }, [threads, dots, query, excludeId, limit, pinyin]);
}

/** A thread open or archived leads to its page; one gone leads nowhere. */
function useThreadMentionTag(id: string): MentionTagTarget | null {
  const known = useManagerThreadsStore((s) => s.threads.has(id) || s.archived.some((t) => t.id === id));
  return known ? { href: threadHref(id) } : null;
}

type CanvasAnswer = { query: string; limit: number } & CanvasMentionsResponse;

/** Canvases whose titles answer the query (holding it, or by pinyin), as
 *  the server finds and orders them (they are many; the page keeps none),
 *  what answered marked. Each says where it came from: its worker, its
 *  thread, or the agent by name. */
function useCanvasMentionOptions(query: string | null, _excludeId: string | null, limit: number) {
  const [answer, setAnswer] = useState<CanvasAnswer | null>(null);
  const agentName = usePersonalAgentStore((s) => personalAgentLabel(s.agent));
  const pinyin = usePinyinMatch(query !== null);
  useEffect(() => {
    if (query === null) return;
    let alive = true;
    fetch(api.canvasMentions(query, limit))
      .then((res) => (res.ok ? res.json() as Promise<CanvasMentionsResponse> : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(
        (body) => { if (alive) setAnswer({ query, limit, canvases: body.canvases ?? [], total: body.total ?? 0 }); },
        // Unread: no canvases are offered for this query.
        () => { if (alive) setAnswer({ query, limit, canvases: [], total: 0 }); }
      );
    return () => { alive = false; };
  }, [query, limit]);
  return useMemo(() => {
    if (query === null || answer === null) return NOTHING;
    const current = answer.query === query && answer.limit === limit;
    // While the answer for what was just typed is on its way, the last
    // answer's canvases that still answer are what there is (the list shows
    // them only once it has waited long enough).
    const canvases = current ? answer.canvases : answer.canvases.filter((c) => titleHit(c.title, query, pinyin)).slice(0, limit);
    return {
      ready: current,
      total: current ? answer.total : canvases.length,
      options: canvases.map((c) => ({
        mention: { kind: "canvas", id: c.id, label: mentionLabel(c.title) },
        content: <CanvasOption canvas={c} marks={titleHit(c.title, query, pinyin)?.marks ?? []} agentName={agentName} />
      }))
    };
  }, [answer, query, limit, agentName, pinyin]);
}

/** A canvas that is there opens over the page, as a canvas link does, its
 *  kind's icon before its title; one gone since is words. Until its title is
 *  read it is taken as there, a report. */
function useCanvasMentionTag(id: string): MentionTagTarget | null {
  const known = useCanvasTitles((s) => s.titles.get(id));
  useEffect(() => { useCanvasTitles.getState().want(id); }, [id]);
  const openCanvas = useOpenCanvas();
  if (known === null) return null;
  const href = `/canvas/${id}`;
  return {
    href,
    open: () => openCanvas(id, href),
    icon: <CanvasIcon kind={known?.kind ?? "report"} className="mr-0.5 inline size-3 align-[-0.1em] text-chrome" />
  };
}

const NO_TASKS: ReadonlyMap<string, never> = new Map<string, never>();

/** The owner's tasks whose titles answer the query (holding it, or by
 *  pinyin): open ones first, then closed, each part by its latest change;
 *  each with its status. */
function useTaskMentionOptions(query: string | null, _excludeId: string | null, limit: number) {
  const tasks = useTaskBoardStore((s) => (query === null ? NO_TASKS : s.tasks ?? NO_TASKS));
  const pinyin = usePinyinMatch(query !== null);
  return useMemo(() => {
    if (query === null) return NOTHING;
    const matching = [...tasks.values()]
      .flatMap((t) => {
        const hit = titleHit(t.title, query, pinyin);
        return hit ? [{ t, hit }] : [];
      })
      .sort((a, b) => Number(isOpen(b.t)) - Number(isOpen(a.t)) || a.hit.rank - b.hit.rank || b.t.updatedAt.localeCompare(a.t.updatedAt));
    return {
      total: matching.length,
      options: matching.slice(0, limit).map(({ t, hit }) => ({
        mention: { kind: "task", id: t.id, label: mentionLabel(t.title) },
        content: (
          <>
            <TaskStatusIcon status={t.status} />
            <MentionTitle title={t.title} marks={hit.marks} />
          </>
        )
      }))
    };
  }, [tasks, query, limit, pinyin]);
}

/** A task the board has opens where tasks open from here; one deleted for
 *  good is words. Until the board is read it is taken as there. */
function useTaskMentionTag(id: string): MentionTagTarget | null {
  const status = useTaskBoardStore((s) => (s.tasks === null ? "unknown" : s.tasks.get(id)?.status ?? (s.deleted.has(id) ? "deleted" : null)));
  const open = useOpenTask();
  if (status === null) return null;
  return {
    href: taskHref(id),
    open: () => open(id),
    ...(status !== "unknown" && status !== "deleted" ? { icon: <TaskStatusIcon status={status} className="mr-0.5 inline size-3 align-[-0.1em]" /> } : {})
  };
}

/** The personal agent, by its name, where the @ asks it to act (a task's
 *  comment box); nowhere else. */
function useAgentMentionOptions(query: string | null, _excludeId: string | null, _limit: number, context: MentionContext) {
  const name = usePersonalAgentStore((s) => personalAgentLabel(s.agent));
  const pinyin = usePinyinMatch(query !== null && context.agent);
  return useMemo(() => {
    if (query === null || !context.agent) return NOTHING;
    const hit = titleHit(name, query, pinyin);
    if (!hit) return NOTHING;
    return {
      total: 1,
      options: [{
        mention: { kind: "agent", id: "personal", label: mentionLabel(name) },
        content: (
          <>
            <Sparkles aria-hidden className="size-3.5 shrink-0 text-status-review" />
            <MentionTitle title={name} marks={hit.marks} />
          </>
        )
      }]
    };
  }, [name, query, context.agent, pinyin]);
}

function useAgentMentionTag(): MentionTagTarget | null {
  return { href: "/agent" };
}

export const MENTION_SOURCES: readonly MentionSource[] = [
  { kind: "agent", heading: "Personal agent", useOptions: useAgentMentionOptions, useTag: useAgentMentionTag },
  { kind: "task", heading: "Tasks", useOptions: useTaskMentionOptions, useTag: useTaskMentionTag },
  { kind: "thread", heading: "Threads", useOptions: useThreadMentionOptions, useTag: useThreadMentionTag },
  { kind: "canvas", heading: "Canvases", useOptions: useCanvasMentionOptions, useTag: useCanvasMentionTag }
];

export function mentionSourceOf(kind: string): MentionSource | undefined {
  return MENTION_SOURCES.find((source) => source.kind === kind);
}

/** The list's groups for an @ being typed (none while `query` is null): one
 *  group per source with something to offer, the four newest of each for a
 *  bare @, eight once something is typed, and how many more there are.
 *  Every source's options hook runs on every render, in the list's fixed
 *  order. */
export function useMentionGroups(query: string | null, excludeId: string | null, context: MentionContext = { agent: false }): MentionGroup[] {
  const limit = query === "" ? BARE_LIMIT : TYPED_LIMIT;
  let ready = true;
  const offered = MENTION_SOURCES.map((source) => {
    // MENTION_SOURCES is a constant list: the same hooks run in the same order on every render.
    const answer = source.useOptions(query, excludeId, limit, context);
    if (answer.ready === false) ready = false;
    return { heading: source.heading, options: answer.options, more: Math.max(0, answer.total - answer.options.length) };
  });
  const groups = offered.filter((group) => group.options.length > 0);
  // Until every group has answered what is typed (or SETTLE_MS has passed),
  // the list keeps what it last showed for this @.
  const asked = query === null ? null : `${limit}:${query}`;
  const [waitedOut, setWaitedOut] = useState<string | null>(null);
  // A wait belongs to one stretch of the same words: typing them again
  // later (or reopening the @) waits again.
  const [waitingFor, setWaitingFor] = useState<string | null>(asked);
  if (waitingFor !== asked) {
    setWaitingFor(asked);
    setWaitedOut(null);
  }
  useEffect(() => {
    if (asked === null || ready) return;
    const timer = setTimeout(() => setWaitedOut(asked), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [asked, ready]);
  const settled = asked !== null && (ready || (waitingFor === asked && waitedOut === asked));
  const [shown, setShown] = useState<MentionGroup[]>(NO_GROUPS);
  // What a settled list shows becomes what an unsettled one keeps showing.
  const next = asked === null ? NO_GROUPS : settled ? groups : shown;
  if (next !== shown && !sameGroups(next, shown)) setShown(next);
  return next;
}

export interface MentionGroup {
  heading: string;
  options: MentionOption[];
  more: number;
}

const NO_GROUPS: MentionGroup[] = [];

/** The same groups: each source's options are kept between renders while its
 *  inputs stand, so the same lists are the same arrays. */
function sameGroups(a: readonly MentionGroup[], b: readonly MentionGroup[]): boolean {
  return a.length === b.length && a.every((group, i) => group.heading === b[i]!.heading && group.options === b[i]!.options && group.more === b[i]!.more);
}

/** An option's key in the list: its kind and id. */
export const mentionOptionKey = (mention: Mention) => `${mention.kind}-${mention.id}`;
