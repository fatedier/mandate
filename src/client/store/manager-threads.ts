import { create } from "zustand";
import type {
  ArchivedThreadDto, ArchiveThreadChoices, ArchiveThreadRefusal, CreateManagerThreadResponse, ManagerThreadDto, ManagerThreadResponse,
  ThreadLabelDto, ThreadLabelsResponse, WorkerFindingsDto
} from "@shared/api/agents";
import { API_PATHS, API_ROUTES } from "@shared/api-contracts";
import { apiPath } from "@/lib/api-base";
import { errorText } from "@shared/error-text";
import type { AgentMessageAttachment } from "@shared/agent-message-types";
import type { Mention } from "@shared/mentions";
import { genLocalId } from "./agent-chat-utils";

interface ManagerThreadsState {
  threads: Map<string, ManagerThreadDto>;
  /** True once the SSE open burst delivered the list. */
  loaded: boolean;
  replaceAll(threads: ManagerThreadDto[]): void;
  upsert(thread: ManagerThreadDto): void;
  create(input: { content?: string; title?: string; attachments?: AgentMessageAttachment[]; mentions?: Mention[] }): Promise<ManagerThreadDto>;
  rename(threadId: string, title: string): Promise<{ ok: true } | { error: string }>;
  /** With its workers. A refusal over work that would be lost names the
   *  workers and what was found in each. */
  /** Archives an open thread. One that is no open thread any more (archived
   *  or deleted elsewhere: the server answers 404) is, as asked: ok. */
  archive(threadId: string, choices?: ArchiveThreadChoices): Promise<{ ok: true } | { error: string; workers?: WorkerFindingsDto[] }>;
  markSeen(threadId: string, seq: number): void;
  /** Reads a thread as the server holds it now, for when an event may have
   *  been missed (an answer refused because its question closed elsewhere);
   *  one that changed while the read was out is newer and stays. */
  refresh(threadId: string): Promise<void>;
  /** The archived threads, newest archived first: the Threads page's
   *  Archived tab, and what an archived thread's page reads. */
  archived: ArchivedThreadDto[];
  /** True once the archived list has been read. */
  archivedLoaded: boolean;
  /** The latest read failed: what the list holds may be missing threads. */
  archivedReadFailed: boolean;
  /** Reads the archived list: it is not streamed, so on each stream open
   *  and after an archive, whose counts only the list carries. */
  loadArchived(): Promise<void>;
  /** Deletes an archived thread for good. A refusal carries the answer's
   *  status: 409 is a thread whose work is still stopping. One already gone
   *  (deleted elsewhere: 404) is deleted, as asked. */
  deleteArchived(threadId: string): Promise<{ ok: true } | { error: string; status?: number }>;
  /** Deletes every archived thread whose work has stopped; `skipped`: the
   *  ones still stopping, left for now. */
  deleteAllArchived(): Promise<{ ok: true; count: number; skipped: number } | { error: string }>;
  /** A thread was deleted (the stream said so, or this tab's delete). */
  removeDeleted(threadId: string): void;
  /** Puts a label on a thread, open or archived, or takes one off: the
   *  thread then has the labels the server answered. */
  addLabel(threadId: string, name: string): Promise<{ ok: true } | { error: string }>;
  removeLabel(threadId: string, name: string): Promise<{ ok: true } | { error: string }>;
}

/** The seenSeq each thread's server copy last reported: a seen write whose
 *  response failed is undone only if the server has not confirmed it. */
const serverSeen = new Map<string, number>();
/** The server's seen mark only moves forward (it stores max()): a late copy
 *  with a lower one must not lower what a response already confirmed. */
function confirmSeen(threadId: string, seq: number): void {
  serverSeen.set(threadId, Math.max(serverSeen.get(threadId) ?? 0, seq));
}
/** Threads the stream said were archived: a late create answer does not bring one back. */
const archivedIds = new Set<string>();
/** Bumped by every full list: one that arrived after a create started and
 *  lacks the thread means it was archived meanwhile (its creation, if it is
 *  open, still arrives on the stream after the list). */
let listGeneration = 0;
/** Threads deleted: an archived list read before the delete does not bring one back. */
const deletedIds = new Set<string>();
/** Each read of the archived list is numbered, and only the latest one's
 *  answer is taken: one that went out before an archive would lack it. */
let archivedReads = 0;

/** PATCH a thread; a lost connection is an error result, like a refusal. */
async function patchThread(threadId: string, patch: Record<string, unknown>): Promise<{ thread: ManagerThreadDto } | { error: string; status?: number; workers?: WorkerFindingsDto[] }> {
  try {
    const response = await fetch(apiPath(API_PATHS.agentManagerThread(threadId)), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    });
    const parsed = await body<ManagerThreadResponse | ArchiveThreadRefusal>(response);
    if (!response.ok || "error" in parsed) {
      const error = "error" in parsed ? parsed.error : `HTTP ${response.status}`;
      return "workers" in parsed && Array.isArray(parsed.workers) ? { error, status: response.status, workers: parsed.workers } : { error, status: response.status };
    }
    return parsed;
  } catch (e) {
    return { error: errorText(e) };
  }
}

async function body<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

/** A label change's answer: the thread's labels, or why not. */
async function labelsAnswer(request: () => Promise<Response>): Promise<{ labels: ThreadLabelDto[] } | { error: string }> {
  try {
    const response = await request();
    const parsed = await body<ThreadLabelsResponse>(response);
    if (!response.ok || "error" in parsed || !Array.isArray(parsed.labels)) return { error: "error" in parsed ? parsed.error : `HTTP ${response.status}` };
    return { labels: parsed.labels };
  } catch (e) {
    return { error: errorText(e) };
  }
}

export const useManagerThreadsStore = create<ManagerThreadsState>((set, get) => ({
  refresh: async (threadId) => {
    const before = get().threads.get(threadId);
    // No route reads one thread: the list has it.
    const response = await fetch(apiPath(API_ROUTES.agentManagerThreads)).catch(() => null);
    if (!response?.ok) return;
    const thread = (await body<{ threads?: ManagerThreadDto[] }>(response)).threads?.find((t) => t.id === threadId);
    if (thread && get().threads.get(threadId) === before) get().upsert(thread);
  },

  threads: new Map(),
  loaded: false,

  replaceAll: (threads) => set((state) => {
    // The first list a store receives starts its record of the server's marks.
    if (!state.loaded) { serverSeen.clear(); archivedIds.clear(); deletedIds.clear(); }
    listGeneration += 1;
    for (const t of threads) confirmSeen(t.id, t.seenSeq);
    return {
    threads: new Map(threads.filter((t) => !t.archivedAt).map((t) => [t.id, forwardSeen(state.threads.get(t.id), t)])),
    loaded: true
    };
  }),

  upsert: (thread) => {
    // In the archived list at once, so a page open on it stays; its counts
    // come with the list, read again.
    const newlyArchived = Boolean(thread.archivedAt) && !deletedIds.has(thread.id) && !get().archived.some((t) => t.id === thread.id);
    set((state) => {
      const threads = new Map(state.threads);
      confirmSeen(thread.id, thread.seenSeq);
      if (thread.archivedAt) { threads.delete(thread.id); archivedIds.add(thread.id); }
      else threads.set(thread.id, forwardSeen(state.threads.get(thread.id), thread));
      // Listed already: what it shows of itself is the thread's, as published
      // (a label put on from any tab); its counts stay the list's.
      if (!newlyArchived) {
        if (!thread.archivedAt || !state.archived.some((t) => t.id === thread.id)) return { threads };
        const archived = state.archived.map((t) => (t.id === thread.id ? { ...t, title: thread.title, labels: thread.labels, projects: thread.projects } : t));
        return { threads, archived };
      }
      const entry: ArchivedThreadDto = { id: thread.id, title: thread.title, archivedAt: thread.archivedAt!, lastActivityAt: thread.lastActivityAt, workers: 0, canvases: 0, labels: thread.labels, projects: thread.projects };
      return { threads, archived: [entry, ...state.archived] };
    });
    if (newlyArchived) void get().loadArchived();
  },

  archived: [],
  archivedLoaded: false,
  archivedReadFailed: false,

  loadArchived: async () => {
    const read = ++archivedReads;
    const response = await fetch(`${apiPath(API_ROUTES.agentManagerThreads)}?archived=1`).catch(() => null);
    const list = response?.ok ? (await body<{ archived?: ArchivedThreadDto[] }>(response)).archived : undefined;
    if (read !== archivedReads) return;
    if (!Array.isArray(list)) { set({ archivedReadFailed: true }); return; }
    set({ archived: list.filter((t) => !deletedIds.has(t.id)), archivedLoaded: true, archivedReadFailed: false });
  },

  deleteArchived: async (threadId) => {
    try {
      const response = await fetch(apiPath(API_PATHS.agentManagerThread(threadId)), { method: "DELETE" });
      const parsed = await body<{ error?: string }>(response);
      if (response.status !== 404 && (!response.ok || parsed.error)) return { error: parsed.error ?? `HTTP ${response.status}`, status: response.status };
    } catch (e) {
      return { error: errorText(e) };
    }
    get().removeDeleted(threadId);
    return { ok: true };
  },

  deleteAllArchived: async () => {
    try {
      const response = await fetch(`${apiPath(API_ROUTES.agentManagerThreads)}?archived=1`, { method: "DELETE" });
      const parsed = await body<{ count?: number; skipped?: number; error?: string }>(response);
      if (!response.ok || typeof parsed.count !== "number") return { error: parsed.error ?? `HTTP ${response.status}` };
      // Each one deleted is also said on the stream; the list read again
      // holds what is left either way.
      void get().loadArchived();
      return { ok: true, count: parsed.count, skipped: parsed.skipped ?? 0 };
    } catch (e) {
      return { error: errorText(e) };
    }
  },

  removeDeleted: (threadId) => {
    deletedIds.add(threadId);
    set((state) => {
      if (!state.archived.some((t) => t.id === threadId) && !state.threads.has(threadId)) return {};
      const threads = new Map(state.threads);
      threads.delete(threadId);
      return { threads, archived: state.archived.filter((t) => t.id !== threadId) };
    });
  },

  addLabel: async (threadId, name) => {
    const answer = await labelsAnswer(() => fetch(apiPath(API_PATHS.agentManagerThreadLabels(threadId)), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name })
    }));
    return "error" in answer ? answer : putLabels(set, threadId, answer.labels);
  },

  removeLabel: async (threadId, name) => {
    const answer = await labelsAnswer(() => fetch(apiPath(API_PATHS.agentManagerThreadLabel(threadId, name)), { method: "DELETE" }));
    return "error" in answer ? answer : putLabels(set, threadId, answer.labels);
  },

  create: async ({ content, title, attachments = [], mentions = [] }) => {
    const generation = listGeneration;
    // A first message is text, images, or both; an image alone is one too.
    const message = Boolean(content) || attachments.length > 0;
    const response = await fetch(apiPath(API_ROUTES.agentManagerThreads), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(message ? { content: content ?? "", clientRequestId: genLocalId() } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(message && mentions.length > 0 ? { mentions } : {}),
        ...(title ? { title } : {})
      })
    });
    const parsed = await body<CreateManagerThreadResponse>(response);
    if (!response.ok || "error" in parsed) throw new Error("error" in parsed ? parsed.error : `HTTP ${response.status}`);
    // The stream may have delivered it first, newer (a reply already landed),
    // or archived it from another tab: the answer does not undo either.
    const id = parsed.thread.id;
    if (!get().threads.has(id) && !archivedIds.has(id) && listGeneration === generation) get().upsert(parsed.thread);
    return parsed.thread;
  },

  rename: async (threadId, title) => {
    const before = get().threads.get(threadId)?.title;
    const result = await patchThread(threadId, { title });
    if ("error" in result) return result;
    // Archived (from another tab) while this was in flight: stay gone. The
    // answer is older than any update that arrived meanwhile: take its title
    // only, and only if nothing renamed it since (our own echo, or another tab).
    const current = get().threads.get(threadId);
    if (current && current.title === before) {
      set((state) => ({ threads: new Map(state.threads).set(threadId, { ...current, title: result.thread.title, named: result.thread.named }) }));
    }
    return { ok: true };
  },

  archive: async (threadId, choices = {}) => {
    const result = await patchThread(threadId, { archived: true, ...choices });
    if ("error" in result) {
      if (result.status === 404) return { ok: true };
      const { status: _status, ...refusal } = result;
      return refusal;
    }
    get().upsert(result.thread);
    return { ok: true };
  },

  markSeen: (threadId, seq) => {
    const current = get().threads.get(threadId);
    if (!current || seq <= current.seenSeq) return;
    // Optimistic, and not the server's copy: set directly, not via upsert.
    set((state) => ({ threads: new Map(state.threads).set(threadId, { ...current, seenSeq: seq }) }));
    // A write that fails is undone — back to what the server last said, not
    // to an earlier optimistic value — so the next view marks it again.
    const undo = () => set((state) => {
      const now = state.threads.get(threadId);
      const confirmed = serverSeen.get(threadId) ?? 0;
      if (!now || now.seenSeq !== seq || confirmed >= seq) return {};
      const threads = new Map(state.threads);
      threads.set(threadId, { ...now, seenSeq: confirmed });
      return { threads };
    });
    void fetch(apiPath(API_PATHS.agentManagerThreadSeen(threadId)), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq })
    }).then(async (response) => {
      if (!response.ok) return undo();
      // What the server now holds, even if its published copy never arrives:
      // a later write that fails falls back to this, not to something older.
      const parsed = await body<ManagerThreadResponse>(response);
      if (!("thread" in parsed)) return;
      confirmSeen(threadId, parsed.thread.seenSeq);
      // An overlapping higher write may have failed and rolled the thread
      // back below what this one just confirmed.
      set((state) => {
        const now = state.threads.get(threadId);
        if (!now || now.seenSeq >= parsed.thread.seenSeq) return {};
        return { threads: new Map(state.threads).set(threadId, { ...now, seenSeq: parsed.thread.seenSeq }) };
      });
    }, undo);
  }
}));

/** The labels the server answered, on the thread wherever it is held: open,
 *  or in the archived list. */
function putLabels(
  set: (update: (state: ManagerThreadsState) => Partial<ManagerThreadsState>) => void,
  threadId: string,
  labels: ThreadLabelDto[]
): { ok: true } {
  set((state) => {
    const open = state.threads.get(threadId);
    if (open) return { threads: new Map(state.threads).set(threadId, { ...open, labels }) };
    if (!state.archived.some((t) => t.id === threadId)) return {};
    return { archived: state.archived.map((t) => (t.id === threadId ? { ...t, labels } : t)) };
  });
  return { ok: true };
}

/** Seen only moves forward: an update published before this tab's seen write
 *  landed must not bring back a New the user already cleared. */
function forwardSeen(current: ManagerThreadDto | undefined, next: ManagerThreadDto): ManagerThreadDto {
  return current && current.seenSeq > next.seenSeq ? { ...next, seenSeq: current.seenSeq } : next;
}
