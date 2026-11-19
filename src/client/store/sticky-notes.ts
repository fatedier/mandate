import { create } from "zustand";
import { api } from "@/lib/api-paths";
import { STICKY_NOTE_LIMITS, type StickyNoteDto, type StickyNoteResponse, type StickyNotesDto, type StickyNotesSeenBody } from "@shared/api/sticky-notes";

interface StickyNotesState {
  /** The open notes as the stream sent them; null until it has. */
  open: Map<string, StickyNoteDto> | null;
  /** The newest done ones (the user's and the agent's removals). */
  done: Map<string, StickyNoteDto>;
  replaceAll(notes: StickyNotesDto): void;
  /** A note as it is now: on the wall when open, in Done when not. An older
   *  copy than the one held (a lower version) changes nothing. */
  upsert(note: StickyNoteDto): void;
  /** The open ones, last changed first. */
  openList(): StickyNoteDto[];
  /** The done ones, last changed first. */
  doneList(): StickyNoteDto[];
  markDone(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  /** These were shown to the user, as they were then. */
  markSeen(shown: readonly StickyNoteDto[]): Promise<void>;
}

async function call<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const answer = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(answer?.error ?? `HTTP ${res.status}`);
  return answer as T;
}

const byVersion = (a: StickyNoteDto, b: StickyNoteDto) => b.version - a.version;

/** The done ones kept: the newest, as the server lists them. */
function capped(done: Map<string, StickyNoteDto>): Map<string, StickyNoteDto> {
  if (done.size <= STICKY_NOTE_LIMITS.doneShown) return done;
  return new Map([...done.values()].sort(byVersion).slice(0, STICKY_NOTE_LIMITS.doneShown).map((n) => [n.id, n]));
}

export const useStickyNotesStore = create<StickyNotesState>()((set, get) => {
  /** A full Done list that lost one to the wall: the next one is the server's to give. */
  const refill = () => {
    void fetch(api.stickyNotes).then((res) => (res.ok ? res.json() as Promise<StickyNotesDto> : null)).then((notes) => { if (notes) get().replaceAll(notes); }).catch(() => {});
  };
  const put = (note: StickyNoteDto) => {
    let leftFullDone = false;
    set((state) => {
      const held = state.open?.get(note.id) ?? state.done.get(note.id);
      if (held && held.version > note.version) return {};
      leftFullDone = !note.doneAt && state.done.has(note.id) && state.done.size >= STICKY_NOTE_LIMITS.doneShown;
      const open = new Map(state.open ?? []);
      const done = new Map(state.done);
      open.delete(note.id);
      done.delete(note.id);
      if (note.doneAt) done.set(note.id, note);
      else open.set(note.id, note);
      return { open, done: capped(done) };
    });
    if (leftFullDone) refill();
  };
  return {
    open: null,
    done: new Map(),
    // A snapshot read before a change the client already has (a reconnect's,
    // passed by an answer to Done or Restore) keeps that change.
    replaceAll: (notes) => set((state) => {
      const held = new Map([...(state.open?.values() ?? []), ...state.done.values()].map((n) => [n.id, n]));
      const latest = new Map<string, StickyNoteDto>();
      for (const note of [...notes.open, ...notes.done]) {
        const mine = held.get(note.id);
        latest.set(note.id, mine && mine.version > note.version ? mine : note);
      }
      const all = [...latest.values()];
      return { open: new Map(all.filter((n) => !n.doneAt).map((n) => [n.id, n])), done: capped(new Map(all.filter((n) => n.doneAt).map((n) => [n.id, n]))) };
    }),
    upsert: put,
    openList: () => [...(get().open?.values() ?? [])].sort(byVersion),
    doneList: () => [...get().done.values()].sort(byVersion),
    markDone: async (id) => { put((await call<StickyNoteResponse>(api.stickyNoteDone(id))).note); },
    restore: async (id) => { put((await call<StickyNoteResponse>(api.stickyNoteRestore(id))).note); },
    markSeen: async (shown) => {
      if (shown.length === 0) return;
      await call<unknown>(api.stickyNotesSeen, { notes: shown.map((n) => ({ id: n.id, version: n.version })) } satisfies StickyNotesSeenBody);
    }
  };
});
