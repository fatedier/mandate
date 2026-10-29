import { create } from "zustand";
import { api } from "@/lib/api-paths";
import { readJson } from "@/lib/api-json";
import {
  AGENT_PAGE_BUILTINS,
  type AgentPageAnswerDto,
  type AgentPageBuiltin,
  type AgentPageDataDto,
  type AgentPageSourceDto,
  type AgentPageStateDto,
  type AgentPageVersionDto
} from "@shared/api/agent-page";

/** What changed in Mandate, as far as the page's built-in data goes. */
export type PageDataEvent = "work" | "questions" | "canvases" | "answers" | "usage";

/** The built-ins each kind of change can alter. */
const BUILTINS_OF: Record<PageDataEvent, readonly AgentPageBuiltin[]> = {
  work: ["threads", "workers", "waiting"],
  questions: ["questions"],
  canvases: ["canvases"],
  answers: ["answers"],
  usage: ["usage"]
};

/** How long a burst of changes is gathered before the data is read again:
 *  usage moves slowly and costs a scan, so it waits longer. */
export const PAGE_DATA_DEBOUNCE_MS: Record<PageDataEvent, number> = { work: 1000, questions: 1000, canvases: 1000, answers: 1000, usage: 30_000 };

const isBuiltin = (name: string): name is AgentPageBuiltin => (AGENT_PAGE_BUILTINS as readonly string[]).includes(name);

interface AgentPageStore {
  state: AgentPageStateDto | null;
  /** The latest version's HTML, once read. */
  version: AgentPageVersionDto | null;
  sources: AgentPageSourceDto[];
  data: Map<string, AgentPageDataDto>;
  /** The sources the page follows: their data is kept current. */
  followed: Set<string>;
  /** What the user typed on the page, by field id: kept here, beyond the
   *  pane (a phone's Chat tab unmounts it), for the next frame. */
  held: Record<string, string>;
  setHeld(values: Record<string, string>): void;
  /** What was typed is done with (an answer was kept): held goes, and
   *  `heldCleared` moves on so the frame showing lets go too. */
  clearHeld(): void;
  heldCleared: number;
  /** State, the latest version and the sources, read again; and the data
   *  of every followed source (the stream may have missed changes). */
  refresh(): Promise<void>;
  /** agentPageUpdated: a new version, or a write began or ended. */
  applyState(state: AgentPageStateDto): void;
  /** agentPageSourceChanged: a source ran, was paused, removed or listed.
   *  No `data`: it read what it had, which stays. */
  applySource(event: { name: string; source: AgentPageSourceDto | null; data?: AgentPageDataDto | null }): void;
  /** Something the built-ins read changed: read the followed ones again, debounced. */
  onEvent(kind: PageDataEvent): void;
  /** A frame wants a source's data, now and as it changes; counted per
   *  frame, so the data is kept current only while some frame wants it. */
  follow(name: string): void;
  /** A frame that followed it is gone. */
  unfollow(name: string): void;
  fetchData(name: string): Promise<void>;
  submit(value: unknown): Promise<{ ok: boolean; error?: string }>;
  setPaused(name: string, paused: boolean): Promise<void>;
  remove(name: string): Promise<void>;
}

const timers = new Map<PageDataEvent, ReturnType<typeof setTimeout>>();
/** How many frames follow each source. */
const followers = new Map<string, number>();

/** One clock for what changes the page's state here. A read takes a tick
 *  when it starts, an event (or a change the user made) when it lands. A
 *  read commits only when it is the newest read of what it reads, and no
 *  event for it landed after the read began: so no older answer ever puts
 *  older state back, whichever order the answers arrive in. */
let clock = 0;
const tick = () => ++clock;
/** For the state: the last event, the last read committed. */
const stateMarks = { event: 0, read: 0 };
/** For the sources list: the last list read committed; each source's last
 *  event from the stream; the start of each source's last change the user
 *  made here that took, and when it took. */
let listRead = 0;
const sourceEvents = new Map<string, number>();
const changeStarts = new Map<string, number>();
const changesTaken = new Map<string, number>();
/** What a source that is not there reads as: settled, with why. */
const absent = (name: string): AgentPageDataDto => ({ name, value: null, at: null, error: "no such source" });
/** The same data again, its read time aside. */
const sameData = (a: AgentPageDataDto | undefined, b: AgentPageDataDto) =>
  a !== undefined && a.error === b.error && JSON.stringify(a.value) === JSON.stringify(b.value);
/** For each source's data: its last event, its last read committed. */
const dataEvents = new Map<string, number>();
const dataReads = new Map<string, number>();

/** Back to nothing read and nothing waiting: for tests. */
export function resetAgentPageStore(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  followers.clear();
  stateMarks.event = 0;
  stateMarks.read = 0;
  listRead = 0;
  sourceEvents.clear();
  changeStarts.clear();
  changesTaken.clear();
  dataEvents.clear();
  dataReads.clear();
  useAgentPageStore.setState({ state: null, version: null, sources: [], data: new Map(), followed: new Set(), held: {}, heldCleared: 0 });
}

export const useAgentPageStore = create<AgentPageStore>()((set, get) => {
  /** A version, unless one at least as new is already here. */
  const loadVersion = async (revision: number) => {
    const version = await readJson<AgentPageVersionDto>(await fetch(api.agentPageVersion(revision)));
    const current = get().version;
    if (!current || current.revision < version.revision) set({ version });
  };
  const commitState = (state: AgentPageStateDto) => {
    set({ state });
    const latest = state.latest;
    const version = get().version;
    if (latest && (!version || version.revision < latest.revision)) void loadVersion(latest.revision).catch(() => {});
  };
  /** Whether a change the user made, started at `started`, still holds: no
   *  event from the stream since (another tab, the source's own run), and
   *  no change of theirs started later that took. One that holds is marked
   *  taken. */
  const takes = (name: string, started: number): boolean => {
    if (started <= (sourceEvents.get(name) ?? 0) || started <= (changeStarts.get(name) ?? 0)) return false;
    changeStarts.set(name, started);
    changesTaken.set(name, tick());
    return true;
  };
  /** A source as it now is (null: gone), and its data when given. */
  const putSource = (name: string, source: AgentPageSourceDto | null, data: AgentPageDataDto | null | undefined) => {
    set((s) => {
      const sources = source
        ? (s.sources.some((x) => x.name === name) ? s.sources.map((x) => (x.name === name ? source : x)) : [...s.sources, source])
        : s.sources.filter((x) => x.name !== name);
      if (data === undefined) return { sources };
      const next = new Map(s.data);
      if (data) next.set(name, data);
      else if (!isBuiltin(name)) next.delete(name);
      return { sources, data: next };
    });
  };

  return {
    state: null,
    version: null,
    sources: [],
    data: new Map(),
    followed: new Set(),
    held: {},
    heldCleared: 0,

    setHeld(values) {
      set({ held: values });
    },

    clearHeld() {
      set((s) => ({ held: {}, heldCleared: s.heldCleared + 1 }));
    },

    async refresh() {
      const stateStarted = tick();
      const state = await readJson<AgentPageStateDto>(await fetch(api.agentPage));
      if (stateStarted > stateMarks.event && stateStarted > stateMarks.read) {
        stateMarks.read = stateStarted;
        commitState(state);
      }
      const listStarted = tick();
      const { sources } = await readJson<{ sources?: AgentPageSourceDto[] }>(await fetch(api.agentPageSources));
      if (listStarted > listRead) {
        listRead = listStarted;
        // The list as read, except the sources an event changed after the
        // read began: those stay as the event left them.
        const read = Array.isArray(sources) ? sources : [];
        const current = new Map(get().sources.map((source) => [source.name, source]));
        const changed = (name: string) => Math.max(sourceEvents.get(name) ?? 0, changesTaken.get(name) ?? 0) > listStarted;
        const next: AgentPageSourceDto[] = [];
        for (const source of read) {
          if (!changed(source.name)) next.push(source);
          else if (current.has(source.name)) next.push(current.get(source.name)!);
        }
        for (const source of current.values()) {
          if (changed(source.name) && !read.some((x) => x.name === source.name)) next.push(source);
        }
        set({ sources: next });
      }
      await Promise.all([...get().followed].map((name) => get().fetchData(name)));
    },

    applyState(state) {
      stateMarks.event = tick();
      commitState(state);
    },

    applySource({ name, source, data }) {
      const at = tick();
      sourceEvents.set(name, at);
      // Its data is an event only when it came: a read of it in flight is
      // as new as anything here.
      if (data !== undefined) dataEvents.set(name, at);
      putSource(name, source, data);
    },

    onEvent(kind) {
      const names = BUILTINS_OF[kind].filter((name) => get().followed.has(name));
      if (names.length === 0 || timers.has(kind)) return;
      timers.set(kind, setTimeout(() => {
        timers.delete(kind);
        for (const name of BUILTINS_OF[kind]) if (get().followed.has(name)) void get().fetchData(name).catch(() => {});
      }, PAGE_DATA_DEBOUNCE_MS[kind]));
    },

    follow(name) {
      const count = (followers.get(name) ?? 0) + 1;
      followers.set(name, count);
      if (count > 1) return;
      // Followed again after a while unfollowed: what is cached may be old,
      // so it goes, and nothing is answered until the fresh read lands.
      set((s) => {
        const data = new Map(s.data);
        data.delete(name);
        return { followed: new Set(s.followed).add(name), data };
      });
      void get().fetchData(name).catch(() => {});
    },

    unfollow(name) {
      const left = (followers.get(name) ?? 0) - 1;
      if (left > 0) {
        followers.set(name, left);
        return;
      }
      followers.delete(name);
      set((s) => {
        const followed = new Set(s.followed);
        followed.delete(name);
        return { followed };
      });
    },

    async fetchData(name) {
      const started = tick();
      const res = await fetch(api.agentPageData(name));
      // A 404: not a source (any more). It reads as absent, settled: a page
      // asking for it gets an answer, and old data goes.
      let data: AgentPageDataDto = absent(name);
      if (res.status !== 404) {
        // Read as it is: a source's data carries an `error` of its own (its
        // last run's), which readJson would take for the request's.
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json() as AgentPageDataDto;
      }
      // Decided once the body is read: a newer read or event wins.
      if (started <= (dataEvents.get(name) ?? 0) || started <= (dataReads.get(name) ?? 0)) return;
      dataReads.set(name, started);
      // Nothing new (a built-in read again, its time aside): the object
      // stays, so the page is not sent the same data again.
      if (sameData(get().data.get(name), data)) return;
      set((s) => ({ data: new Map(s.data).set(name, data) }));
    },

    async submit(value) {
      try {
        await readJson<{ answer: AgentPageAnswerDto }>(await fetch(api.agentPageAnswers, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value })
        }));
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "not sent" };
      }
    },

    async setPaused(name, paused) {
      const started = tick();
      const { source } = await readJson<{ source: AgentPageSourceDto }>(await fetch(api.agentPageSource(name), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paused })
      }));
      if (!takes(name, started)) return;
      putSource(name, source, undefined);
    },

    async remove(name) {
      const started = tick();
      await readJson<{ removed: true }>(await fetch(api.agentPageSource(name), { method: "DELETE" }));
      if (!takes(name, started)) return;
      dataEvents.set(name, tick());
      putSource(name, null, null);
    }
  };
});
