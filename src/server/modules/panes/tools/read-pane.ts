import { z } from "zod";
import { requireFeatureToolContext, type ToolDefinition } from "../../agent/tool-registry.js";
import { MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS } from "../../agent/wake-message-adapter.js";
import { exceedsInlineToolResultLimits } from "../../agent/tool-output-spool.js";
import { paneInFeature } from "./pane-helpers.js";
import { collapseSeenPrefix } from "../pane-read-collapse.js";
import type { PaneReadCursorStore } from "../pane-read-cursor.js";
import type { StoredWatch, WindowWatchManager } from "../../agent/window-watch-manager.js";

const params = z.object({
  paneId: z.string(),
  lines: z.number().int().positive().max(2000).optional()
});

/** Reads with nothing new before we suggest watch_window. 3 leaves the honest
 *  "sent a command, took a look" read alone and only speaks up to a poller. */
const IDLE_NUDGE_AFTER = 3;

interface ReadPaneError {
  error: string;
}

export function buildReadPaneTool(deps: {
  cursors: PaneReadCursorStore;
  watchManager?: Pick<WindowWatchManager, "hasWatchForPane">;
}): ToolDefinition<z.infer<typeof params>, string | ReadPaneError> {
  return {
    name: "read_pane",
    description:
      "Capture the last N lines from a pane in this feature as one text block. Default 200. "
      + "Lines you were already shown by your previous read of the same pane are replaced by a one-line marker. "
      + "The marker means those exact lines were in your previous read, not that the pane did nothing: "
      + "a command rerun whose output is identical collapses the same way.",
    parameters: params,
    approval: "never",
    handler: async ({ paneId, lines = 200 }, ctx) => {
      const featureCtx = requireFeatureToolContext(ctx);
      if (!(await paneInFeature(paneId, ctx))) {
        // A scope-check failure, not a content read: a watch reminder here
        // would be noise attached to a different problem, so this return is
        // deliberately not routed through withWatchNote below.
        return { error: `pane ${paneId} is not in this feature (scope check failed)` };
      }

      // Computed once, ahead of the four content returns below, and applied
      // through withWatchNote so every one of them carries it — hand-editing
      // each return individually reliably misses one.
      //
      // The note is a PREFIX, never a suffix. Two independent mechanisms cut
      // this tool's result down before an agent sees all of it: the dispatcher
      // spools anything over 64KB/2000 lines to a file and returns only a
      // head preview (tool-output-spool.ts), and wake-message-adapter.ts caps
      // every string result at MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS by keeping
      // the HEAD. A suffix note would (a) be silently dropped by either cut
      // whenever the note pushed an already-near-the-limit payload over it,
      // and (b) be invisible below the fold on anything longer than a
      // screenful even when it does survive. A prefix survives both.
      const watch = deps.watchManager?.hasWatchForPane(ctx.threadId, paneId) ?? null;
      const watchNote = watch ? alreadyWatchingNote(watch, Date.now()) : null;
      const withWatchNote = (content: string): string =>
        watchNote ? `${watchNote}\n${content}` : content;

      const text = await featureCtx.paneRuntime.readScrollback(paneId, { tailLines: lines });
      const all = text.split("\n");
      if (all.length > 0 && all[all.length - 1] === "") all.pop();
      const full = all.join("\n");

      const cursor = deps.cursors.get(ctx.threadId, paneId);
      const collapsed = collapseSeenPrefix(full, cursor?.lines ?? null, { paneId });

      if (!collapsed.hasNew) {
        // Nothing is new, so every line of this capture matched the cursor and
        // is therefore already in the agent's context from an earlier read.
        // Remember all of it however long the capture is — this payload is one
        // short sentence, so it can be neither truncated nor spooled.
        const idleStreak = deps.cursors.remember(ctx.threadId, paneId, full, false);
        if (idleStreak >= IDLE_NUDGE_AFTER) {
          return withWatchNote(
            `${collapsed.text}\nThis pane has not changed across your last ${idleStreak} reads. `
              + "watch_window wakes you once a pane has been quiet for a set duration, "
              + "so register it when you start long-running work in a pane instead of re-reading it."
          );
        }
        return withWatchNote(collapsed.text);
      }

      // Built once and reused below: this is the exact string the caller gets
      // back, and both the spool-size check and the cursor accounting have to
      // reason about that string, not the bare pane content it's built from —
      // the note's own length counts against both the 64KB/2000-line spool
      // threshold and the 20K wake-time cap.
      const finalText = withWatchNote(collapsed.text);

      if (exceedsInlineToolResultLimits(finalText)) {
        // The dispatcher is about to swap this for a short preview plus a file
        // path, so barely any of these lines reach the agent. Claim none of
        // them: forget the pane and let the next read come back whole.
        deps.cursors.forget(ctx.threadId, paneId);
        return finalText;
      }

      // Remember the FULL capture, never just `collapsed.text`: the next read has
      // to recognise the lines we hid, not only the tail we printed. But remember
      // no more of it than the agent is actually given — see modelVisiblePartOf.
      // Pass finalText, the note included: the note is part of what the model
      // receives and part of what the 20K head-keep cuts against, so the
      // accounting must describe the same string that cut applies to.
      deps.cursors.remember(ctx.threadId, paneId, modelVisiblePartOf(full, finalText), true);
      return finalText;
    }
  };
}

/**
 * Tells a reader it already holds a window watch on this pane: that the
 * watch exists, when it will fire, and that reading now does not move that
 * up. Deliberately does NOT say "register a watch" — that is IDLE_NUDGE_AFTER's
 * suggestion above, aimed at an agent that does not yet have one; this note
 * is for an agent that already does, and the two can fire on the same read.
 */
function alreadyWatchingNote(watch: StoredWatch, nowMs: number): string {
  const stableSec = Math.max(1, Math.round(watch.stableMs / 1000));
  const ageSec = Math.max(0, Math.round((nowMs - watch.createdAtMs) / 1000));
  return `You already have a watch on this pane (fires after ${stableSec}s of quiet; `
    + `registered ${ageSec}s ago). It will wake you — re-reading does not make it fire sooner.`;
}

/**
 * The part of `full` that will really be in the agent's context, given that
 * `payload` is the EXACT string this tool returns to its caller — including
 * the watch note prefix, when there is one (see withWatchNote above). Pass
 * anything shorter than what's truly returned and this function computes
 * against the wrong cap crossing, over-claiming characters the agent was
 * never shown.
 *
 * Every string tool result is cut down to MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS
 * before it reaches the model, and that cut keeps the HEAD (see `limitToolText`
 * in modules/agent/tool-result-format.ts). Since read_pane returns a pane's
 * tail, an oversized result loses its newest lines — exactly the ones a cursor
 * must not go on to claim the agent has seen.
 *
 * `payload` always ends in a verbatim suffix of `full`: collapsing only ever
 * swaps a leading run of lines for a single marker line, and the watch note
 * is a PREFIX in front of that — never a suffix — so it never touches the
 * end of the string. That's exactly why the note has to be a prefix: a
 * suffix note would break this invariant, and this function's arithmetic
 * (finding the cut by walking back from the cap) depends on it. So the
 * characters the cap takes off the end of `payload` are precisely the
 * characters of `full` we must not remember — whether or not the marker, the
 * note, or both together made the payload shorter than the capture it
 * describes.
 */
function modelVisiblePartOf(full: string, payload: string): string {
  if (payload.length <= MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS) return full;
  // Stop at a line boundary: half a line is not a line a later read can match.
  const lastBreak = payload.lastIndexOf("\n", MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS - 1);
  const dropped = payload.length - Math.max(lastBreak, 0);
  return full.slice(0, Math.max(0, full.length - dropped));
}
