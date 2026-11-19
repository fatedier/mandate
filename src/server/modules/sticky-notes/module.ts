import type { Context } from "hono";
import type { MandateModule } from "../module.js";
import { initializeStickyNotesSchema } from "./schema.js";
import { StickyNoteRefusal } from "./sticky-notes-service.js";
import { API_ROUTES } from "../../../shared/api-contracts.js";
import type { StickyNoteResponse, StickyNotesDto } from "../../../shared/api/sticky-notes.js";

/** A refusal is the caller's to read; anything else is ours. */
function answer(c: Context, run: () => Response): Response {
  try {
    return run();
  } catch (err) {
    if (err instanceof StickyNoteRefusal) return c.json({ error: err.message }, err.status);
    throw err;
  }
}

/** The user's routes for the agent's sticky notes. The agent writes through
 *  its tool, never through these. */
export const stickyNotesModule: MandateModule = {
  id: "sticky-notes",
  schema: [initializeStickyNotesSchema],
  mountRoutes: (app, { deps }) => {
    const notes = deps.stickyNotes;
    if (!notes) return;
    app.get(API_ROUTES.stickyNotes, (c) => c.json(notes.list() satisfies StickyNotesDto));
    app.post(API_ROUTES.stickyNotesSeen, async (c) => {
      const input = await c.req.json().catch(() => null) as { notes?: unknown } | null;
      const shown = input?.notes;
      const valid = Array.isArray(shown) && shown.every((n: unknown) => !!n && typeof (n as { id?: unknown }).id === "string" && Number.isInteger((n as { version?: unknown }).version));
      if (!valid) return c.json({ error: "notes must be a list of {id, version} as shown" }, 400);
      notes.markSeen(shown as Array<{ id: string; version: number }>);
      return c.json({ ok: true });
    });
    app.post(API_ROUTES.stickyNoteDone, (c) => answer(c, () => c.json({ note: notes.done(c.req.param("id")) } satisfies StickyNoteResponse)));
    app.post(API_ROUTES.stickyNoteRestore, (c) => answer(c, () => c.json({ note: notes.restore(c.req.param("id")) } satisfies StickyNoteResponse)));
  }
};
