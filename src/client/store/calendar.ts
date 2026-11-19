import { useEffect, useState } from "react";
import { create } from "zustand";
import { api } from "@/lib/api-paths";
import type { CalendarDto } from "@shared/api/calendar";

interface CalendarState {
  /** Rises with every change the server tells of (and every reconnect): a view fetches its range again. */
  stamp: number;
  ping(): void;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  /** "Only this one": that due time of a repeat is not delivered. */
  skip(id: string, at: number): Promise<void>;
  remove(id: string): Promise<void>;
}

async function send(url: string, method: "POST" | "DELETE", body?: unknown): Promise<void> {
  await fetch(url, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).catch(() => null);
}

/** The calendar's writes are the page's few: pause, resume, skip one time, delete.
 *  Whatever the answer, the range is fetched again and shows what holds. */
export const useCalendarStore = create<CalendarState>()((set, get) => {
  const after = async (write: Promise<void>) => {
    await write;
    get().ping();
  };
  return {
    stamp: 0,
    ping: () => set((s) => ({ stamp: s.stamp + 1 })),
    pause: (id) => after(send(api.calendarPause(id), "POST", {})),
    resume: (id) => after(send(api.calendarResume(id), "POST", {})),
    skip: (id, at) => after(send(api.calendarSkip(id), "POST", { at })),
    remove: (id) => after(send(api.calendarEntry(id), "DELETE"))
  };
});

/** The calendar's entries and times from `from` to `to`, fetched again when
 *  the range changes or the server tells of a change. */
export function useCalendarRange(from: number, to: number): { data: CalendarDto | null; error: boolean } {
  const stamp = useCalendarStore((s) => s.stamp);
  const [state, setState] = useState<{ key: string; data: CalendarDto | null; error: boolean }>({ key: "", data: null, error: false });
  const key = `${from}:${to}`;
  useEffect(() => {
    const abort = new AbortController();
    void fetch(api.calendar(from, to), { signal: abort.signal })
      .then((res) => (res.ok ? (res.json() as Promise<CalendarDto>) : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => setState({ key, data, error: false }))
      // A range that failed shows nothing: never the one before it, under its key.
      .catch(() => { if (!abort.signal.aborted) setState((s) => ({ key, data: s.key === key ? s.data : null, error: true })); });
    return () => abort.abort();
  }, [from, to, key, stamp]);
  // A range not fetched yet shows nothing of the one before.
  return state.key === key ? { data: state.data, error: state.error } : { data: null, error: false };
}
