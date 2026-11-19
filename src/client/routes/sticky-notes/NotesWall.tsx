import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNow } from "@/hooks/useNow";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { useStickyNotesStore } from "@/store/sticky-notes";
import { personalAgentLabel } from "@/lib/personal-agent-label";
import type { StickyNoteDto } from "@shared/api/sticky-notes";
import { NoteCard } from "./NoteCard";
import { shownKey, useShownNotes } from "./shown-notes";
import { noteTime } from "./note-time";

const byVersion = (a: StickyNoteDto, b: StickyNoteDto) => b.version - a.version;

/** The agent's sticky notes: a wall of them, last changed first, and under it
 *  the Done list. The one component the Notes page and the agent's panel tab
 *  draw. While it is in sight, what it shows new is told as seen (each as
 *  shown) and keeps its tape here until it goes out of sight. */
export function NotesWall({ inSight }: {
  /** Shown to the user now: on a page in front, the tab chosen, the panel turned to. */
  inSight: boolean;
}) {
  const openMap = useStickyNotesStore((s) => s.open);
  const doneMap = useStickyNotesStore((s) => s.done);
  const agent = usePersonalAgentStore((s) => s.agent);
  const agentName = personalAgentLabel(agent);
  const open = useMemo(() => [...(openMap?.values() ?? [])].sort(byVersion), [openMap]);
  const done = useMemo(() => [...doneMap.values()].sort(byVersion), [doneMap]);
  const [showDone, setShowDone] = useState(false);
  const now = useNow();
  const view = useId();
  const shown = useShownNotes((s) => s.byView.get(view));
  const wallRef = useRef<HTMLDivElement | null>(null);
  // The looks told and not refused: one that failed is told again when the
  // notes come anew (a reconnect's snapshot), its tape kept meanwhile.
  const told = useRef(new Set<string>());
  useEffect(() => {
    if (!inSight) return;
    // After a frame, and only if the browser shows the wall: a narrow row
    // not yet measured is drawn wide for a moment, its side about to hide.
    const frame = requestAnimationFrame(() => {
      const el = wallRef.current;
      if (!el || (typeof el.checkVisibility === "function" && !el.checkVisibility())) return;
      const fresh = open.filter((note) => !note.seen && !told.current.has(shownKey(note)));
      if (fresh.length === 0) return;
      for (const note of fresh) told.current.add(shownKey(note));
      useShownNotes.getState().add(view, fresh.map(shownKey));
      void useStickyNotesStore.getState().markSeen(fresh).catch(() => { for (const note of fresh) told.current.delete(shownKey(note)); });
    });
    return () => cancelAnimationFrame(frame);
  }, [inSight, open, view]);
  // Out of sight, a later look starts over: what was seen keeps no tape.
  useEffect(() => (inSight ? () => { useShownNotes.getState().clear(view); told.current.clear(); } : undefined), [inSight, view]);
  const isNew = (note: StickyNoteDto) => !note.seen || (shown?.has(shownKey(note)) ?? false);
  const fresh = open.filter(isNew).length;
  return (
    <div ref={wallRef} data-slot="notes-wall" className="flex min-w-0 flex-col">
      <div className="mb-[18px] flex min-w-0 items-baseline gap-2">
        <span data-slot="notes-count" className="text-[13px] font-semibold text-foreground">
          {open.length === 0 ? "No notes." : open.length === 1 ? "1 note" : `${open.length} notes`}
        </span>
        {fresh > 0 && <span data-slot="notes-new" className="text-[12.5px] font-medium text-status-review">· {fresh} new</span>}
        <span className="flex-1" />
        {done.length > 0 && (
          <button type="button" onClick={() => setShowDone((v) => !v)} className="hit relative shrink-0 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded-sm">
            {showDone ? "Hide done" : `Show done (${done.length})`}
          </button>
        )}
      </div>
      {/* A row's cards are one height, but while one is opened whole: then each its own, the others not stretched to it. */}
      {open.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-x-4 gap-y-[18px] max-md:grid-cols-1 [&:has([data-whole])]:items-start">
          {open.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              isNew={isNew(note)}
              agentName={agentName}
              now={now}
              onDone={() => { void useStickyNotesStore.getState().markDone(note.id).catch(() => {}); }}
            />
          ))}
        </div>
      )}
      {showDone && done.length > 0 && (
        <section aria-label="Done" className="mt-[26px] min-w-0">
          <h3 className="m-0 mb-1.5 px-0.5 text-xs font-semibold text-faint">Done</h3>
          {done.map((note) => <DoneRow key={note.id} note={note} agentName={agentName} now={now} />)}
        </section>
      )}
    </div>
  );
}

function DoneRow({ note, agentName, now }: { note: StickyNoteDto; agentName: string; now: number }) {
  const when = note.doneAt ? noteTime(note.doneAt, now) : "";
  const said = note.doneBy === "agent" ? `Removed by ${agentName} ${when}: ${note.reason ?? ""}` : `Done ${when}`;
  return (
    <div data-slot="sticky-note-done-row" className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 border-t border-border-soft px-1 py-[7px] text-[12.5px] md:flex-nowrap">
      <span aria-hidden className="size-2.5 shrink-0 rounded-[3px] shadow-[inset_0_0_0_1px_rgba(127,127,127,0.25)]" style={{ background: `var(--note-${note.kind}-band)` }} />
      <span data-slot="sticky-note-done-title" className="min-w-0 flex-1 truncate text-muted-foreground">{note.title}</span>
      <span data-slot="sticky-note-done-when" title={said} className="order-3 basis-full pl-5 text-[11.5px] text-faint md:order-none md:basis-auto md:max-w-[46%] md:truncate md:pl-0">{said}</span>
      <button type="button" onClick={() => { void useStickyNotesStore.getState().restore(note.id).catch(() => {}); }} className="hit relative shrink-0 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
        Restore
      </button>
    </div>
  );
}
