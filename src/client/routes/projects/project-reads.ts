import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-paths";
import { DEFAULT_FILTERS, entriesQuery } from "@/routes/memory/memory-filters";
import type { MemoryBriefsResponse, MemoryEntriesResponse } from "@shared/api/memory";
import type { ProjectCanvasesResponse } from "@shared/api/canvas";

/** A read from the server: on its way, failed, or what it answered. */
export type Read<T> = { state: "loading" } | { state: "failed" } | { state: "read"; value: T };

/** How many reports the page shows. */
const REPORTS_SHOWN = 4;

interface ProjectReads {
  /** The project's memory brief; null when it has none yet. */
  brief: Read<string | null>;
  /** Its live memories, as the Memory page filtered to it lists them. */
  memories: Read<number>;
  /** Its newest reports and how many it has. */
  reports: Read<ProjectCanvasesResponse>;
}

const LOADING = { state: "loading" } as const;
const UNREAD: ProjectReads = { brief: LOADING, memories: LOADING, reports: LOADING };

/** The body of a GET that answered 2xx, else a throw. */
async function readJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json() as T;
}

/** What answered, or that it failed; nothing once the read is called off. */
function settle<T>(read: Promise<T>, signal: AbortSignal, put: (result: Read<T>) => void): void {
  read.then(
    (value) => { if (!signal.aborted) put({ state: "read", value }); },
    () => { if (!signal.aborted) put({ state: "failed" }); }
  );
}

/**
 * What a project's page reads from the server: its brief, how many memories
 * it has, its newest reports. Read when the page opens on a project and
 * when Retry asks; the reports again whenever a canvas is published or
 * deleted and after the stream reconnects (the newest such read wins). An
 * answer for a project the page has left is dropped.
 */
export function useProjectReads(projectId: string): ProjectReads & { retry(): void } {
  const [held, setHeld] = useState<{ projectId: string; reads: ProjectReads }>({ projectId, reads: UNREAD });
  const [round, setRound] = useState(0);

  useEffect(() => {
    const visit = new AbortController();
    const put = (patch: Partial<ProjectReads>) => setHeld((current) => ({
      projectId,
      reads: { ...(current.projectId === projectId ? current.reads : UNREAD), ...patch }
    }));
    // Another project's reads count as none (below); a Retry keeps what it
    // says until the new answers come.
    settle(
      readJson<MemoryBriefsResponse>(api.memoryBriefs, visit.signal)
        .then((body) => body.briefs.find((b) => b.scope === "project" && b.projectId === projectId)?.content ?? null),
      visit.signal, (brief) => put({ brief })
    );
    settle(
      readJson<MemoryEntriesResponse>(api.memoryEntries(entriesQuery({ ...DEFAULT_FILTERS, projectId }, { limit: 1, offset: 0 })), visit.signal)
        .then((body) => body.total),
      visit.signal, (memories) => put({ memories })
    );
    let reportsRead: AbortController | null = null;
    const readReports = () => {
      reportsRead?.abort();
      const mine = new AbortController();
      reportsRead = mine;
      settle(readJson<ProjectCanvasesResponse>(api.projectCanvases(projectId, REPORTS_SHOWN), mine.signal), mine.signal, (reports) => setHeld((current) => {
        const reads = current.projectId === projectId ? current.reads : UNREAD;
        // A read again that fails leaves what an earlier one showed.
        if (reports.state === "failed" && reads.reports.state === "read") return current;
        return { projectId, reads: { ...reads, reports } };
      }));
    };
    readReports();
    // The reports change as agents publish; the brief and the count change
    // with the dream, a few times a day: those wait for the next visit.
    window.addEventListener("mandate:canvas-updated", readReports);
    window.addEventListener("mandate:sse-open", readReports);
    return () => {
      visit.abort();
      reportsRead?.abort();
      window.removeEventListener("mandate:canvas-updated", readReports);
      window.removeEventListener("mandate:sse-open", readReports);
    };
  }, [projectId, round]);

  const retry = useCallback(() => setRound((n) => n + 1), []);
  return { ...(held.projectId === projectId ? held.reads : UNREAD), retry };
}
