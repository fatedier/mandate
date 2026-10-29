import { isRecord } from "@shared/guards";
import type { ToolCallSpec, ToolResultSpec } from "../tool-run-summary";

/** Names for the ids tool calls carry: `%133` is the pane someone named
 *  "Codex review", `feat_…` a feature with a name.
 *
 *  A pane goes by the name it had when the call acted on it. Its name later
 *  says what it was doing later: agents give a pane its next task and rename
 *  it (by its latest name, many of the calls on a pane would
 *  read by a name the pane was only given after them), and tmux hands `%4`
 *  out again once its server restarts. */
export interface ToolNames {
  /** Each call that acted on a named pane: the name the pane had when the
   *  call was made. */
  paneOfCall: ReadonlyMap<string, string>;
  features: ReadonlyMap<string, string>;
  /** A canvas's title by id, the latest a call gave or reported. */
  canvases: ReadonlyMap<string, string>;
  /** Each watch the thread registered: the name its pane had then, which the
   *  event that fires later goes by — the task the watch's note is about. */
  watchPanes: ReadonlyMap<string, string>;
  /** Each read of a file a tool's output was saved to: the call that output
   *  came from. An output too large to hand back whole is saved to a file
   *  named by a random id (tool-output-spool.ts), which the agent then reads
   *  in parts; the id says nothing, the call it came from does. */
  savedOutputOfRead: ReadonlyMap<string, SavedOutputSource>;
}

export interface SavedOutputSource {
  call: ToolCallSpec;
  result: ToolResultSpec;
}

export const NO_NAMES: ToolNames = {
  paneOfCall: new Map(),
  features: new Map(),
  canvases: new Map(),
  watchPanes: new Map(),
  savedOutputOfRead: new Map()
};

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** A name as shown: trimmed, and none when blank. */
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Where a result says its output was saved (tool-output-spool.ts writes the
 *  path on the line after the first), or null for any other result. */
function savedOutputPath(result: ToolResultSpec): string | null {
  if (typeof result.result !== "string") return null;
  return result.result.match(/^<persisted-output>\n[^\n]*Full output saved to:\n([^\n]+)\n/)?.[1] ?? null;
}

/** An id exactly as written: `" %4 "` is not `%4`, and the server, which
 *  matches ids exactly, did not take it for `%4` either. */
function exactId(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Names as the thread itself recorded them, in the order it did. Each call
 *  that says what a pane is called — or that it has no name — is the word on
 *  it from then on: renamed, the pane reads by the newer name in the calls
 *  after, and calls before keep the one they had; seen unnamed, it goes back
 *  to its id; returned by a spawn_pane, it is a new pane, with the name that
 *  call gave it or none. Pane names come from the thread and never from a
 *  lookup of whatever pane holds that id today, since tmux reuses ids.
 *
 *  Only calls that came back without an error say anything about a name: a
 *  spawn that failed named nothing. */
export function collectToolNames(
  calls: Iterable<ToolCallSpec>,
  resultsByCallId: ReadonlyMap<string, ToolResultSpec>
): ToolNames {
  const paneOfCall = new Map<string, string>();
  const features = new Map<string, string>();
  const canvases = new Map<string, string>();
  const watchPanes = new Map<string, string>();
  const savedOutputOfRead = new Map<string, SavedOutputSource>();
  // Each saved output's path, and the call it came from, as of the call being read.
  const savedOutputs = new Map<string, SavedOutputSource>();
  // Each pane id's name as of the call being read.
  const panes = new Map<string, string>();
  const observePane = (id: string | null, name: string | null) => {
    if (!id) return;
    if (name) panes.set(id, name);
    else panes.delete(id);
  };
  for (const call of calls) {
    const result = resultsByCallId.get(call.toolCallId);
    const ok = Boolean(result && !result.isError);
    const args = record(call.args);
    const value = ok ? record(result!.result) : null;
    const reportedError = Boolean(value && typeof value.error === "string" && value.ok !== true);
    // Every call that names a pane acted on it as it was named when the call
    // was made, whatever came of the call. (A spawn names none: its pane is
    // new, and goes by the name the spawn gave it.)
    // A pane monitor names its pane inside `pane`.
    const acted = exactId(call.toolName === "monitor" ? record(args?.pane)?.paneId : args?.paneId);
    const actedName = acted ? panes.get(acted) : undefined;
    if (actedName) paneOfCall.set(call.toolCallId, actedName);
    // A read of a saved output, matched by the path exactly as the result gave
    // it; only an earlier call's output can be read.
    const readPath = call.toolName === "read" && typeof args?.path === "string" ? args.path : null;
    const source = readPath ? savedOutputs.get(readPath) : undefined;
    if (source) savedOutputOfRead.set(call.toolCallId, source);
    const savedTo = ok ? savedOutputPath(result!) : null;
    if (savedTo) savedOutputs.set(savedTo, { call, result: result! });
    if (!ok || reportedError) continue;
    switch (call.toolName) {
      case "spawn_pane":
        // A new pane, whatever its id named before.
        observePane(exactId(value?.paneId), text(args?.name));
        break;
      case "set_pane_metadata":
        // Without `name` the call changed something else; with an empty one
        // it cleared the name.
        if (args && "name" in args) observePane(exactId(args.paneId), text(args.name));
        break;
      case "pane_status": {
        // What the check found is the name the pane had when it was made.
        const name = text(value?.name);
        observePane(exactId(args?.paneId), name);
        if (name) paneOfCall.set(call.toolCallId, name);
        else paneOfCall.delete(call.toolCallId);
        break;
      }
      case "list_panes":
        for (const pane of Array.isArray(value?.panes) ? value.panes : []) {
          const entry = record(pane);
          observePane(exactId(entry?.paneId), text(entry?.name));
        }
        break;
      case "monitor": {
        // A pane monitor, as a watch: the name its pane had at registration.
        const monitorId = value?.status === "registered" && value.kind === "pane" ? exactId(value.monitorId) : null;
        const name = paneOfCall.get(call.toolCallId);
        if (monitorId && name) watchPanes.set(monitorId, name);
        break;
      }
      case "canvas_create":
      case "canvas_publish":
      case "canvas_read":
      case "canvas_update": {
        const id = exactId(value?.canvasId);
        const title = text(value?.title);
        if (id && title) canvases.set(id, title);
        break;
      }
      case "create_feature": {
        const id = exactId(value?.featureId);
        const name = text(value?.featureName) ?? text(args?.name);
        if (id && name) features.set(id, name);
        break;
      }
      case "get_feature_status": {
        const feature = record(value?.feature);
        const id = exactId(feature?.id);
        const name = text(feature?.name);
        if (id && name) features.set(id, name);
        break;
      }
      case "list_features": {
        for (const item of Array.isArray(value?.features) ? value.features : []) {
          const entry = record(item);
          const id = exactId(entry?.id);
          const name = text(entry?.name);
          if (id && name) features.set(id, name);
        }
        break;
      }
    }
  }
  return { paneOfCall, features, canvases, watchPanes, savedOutputOfRead };
}
