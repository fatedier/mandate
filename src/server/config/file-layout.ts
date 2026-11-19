import { isObject } from "./json.js";
import type { JsonObject } from "./types.js";

/**
 * config.json groups its keys; the app's Config and the Settings API keep
 * them flat. This is the one table between the two: `flatFromFile` reads a
 * checked file into the flat form the loader merges, `fileFromFlat` writes
 * what Settings patched back into the file's groups. A key the table does
 * not know stays where it is (at the top, or in `agent`); a flat key left in
 * a grouped file (an old layout's) is not read.
 */

type Path = readonly string[];

/** Top-level flat keys and where the file keeps them. */
export const TOP: ReadonlyArray<readonly [string, Path]> = [
  ["port", ["server", "port"]],
  ["host", ["server", "host"]],
  ["checkOrigin", ["server", "checkOrigin"]],
  ["pollIntervalMs", ["panes", "pollIntervalMs"]],
  ["captureLines", ["panes", "captureLines"]]
];
const TOP_GROUPS = ["server", "panes"];

/** Each model route: flat `<route>Model` + `<route>ModelFallbacks`, one
 *  object `{ model, reasoningEffort, serviceTier, fallbacks }` in the file,
 *  under `agent`. */
export const ROUTES: ReadonlyArray<readonly [string, Path]> = [
  ["manager", ["routes", "manager"]],
  ["worker", ["routes", "worker"]],
  ["personal", ["routes", "personal"]],
  ["dream", ["routes", "dream"]],
  ["extraction", ["routes", "extraction"]],
  ["subagent", ["routes", "subagent"]],
  ["page", ["routes", "page"]],
  ["skillReview", ["routes", "skillReview"]],
  ["decisions", ["decisions"]],
  ["managerRequestCheck", ["checks", "managerRequest"]],
  ["managerStopCheck", ["checks", "managerStop"]],
  ["memoryRepeatCheck", ["checks", "memoryRepeat"]],
  ["toolReviewScreen", ["toolReview", "screen"]],
  ["toolReviewSecondLook", ["toolReview", "secondLook"]]
];

/** Other flat `agent` keys that live in a group, under `agent`. */
export const AGENT: ReadonlyArray<readonly [string, Path]> = [
  ["decisionsEnabled", ["decisions", "enabled"]],
  ["managerRequestCheckEnabled", ["checks", "managerRequest", "enabled"]],
  ["managerStopCheckEnabled", ["checks", "managerStop", "enabled"]],
  ["memoryRepeatCheckEnabled", ["checks", "memoryRepeat", "enabled"]],
  ["toolReviewEnabled", ["toolReview", "enabled"]],
  ["toolReviewRules", ["toolReview", "rules"]],
  ["compressionThresholdTokens", ["compaction", "thresholdTokens"]],
  ["idleCompactionEnabled", ["compaction", "idle", "enabled"]],
  ["idleCompactionLeadMinutes", ["compaction", "idle", "leadMinutes"]],
  ["idleCompactionMinTokens", ["compaction", "idle", "minTokens"]]
];
const AGENT_GROUPS = ["routes", "decisions", "checks", "toolReview", "compaction"];

/** The flat agent keys the table places in a group. */
const AGENT_FLAT_KEYS = new Set([
  ...ROUTES.flatMap(([route]) => [`${route}Model`, `${route}ModelFallbacks`]),
  ...AGENT.map(([key]) => key)
]);

const SELECTION_KEYS = ["model", "reasoningEffort", "serviceTier"];

function get(root: unknown, path: Path): unknown {
  let at = root;
  for (const key of path) {
    if (!isObject(at)) return undefined;
    at = at[key];
  }
  return at;
}

function set(root: JsonObject, path: Path, value: unknown): void {
  let at = root;
  for (const key of path.slice(0, -1)) {
    if (!isObject(at[key])) at[key] = {};
    at = at[key] as JsonObject;
  }
  at[path[path.length - 1]!] = value;
}

/** A route's model, effort and tier that are set (null and a bare blank ref
 *  are not: an unset route reads so). */
function selectionOf(value: unknown): JsonObject {
  if (typeof value === "string") return value.trim() ? { model: value } : {};
  if (!isObject(value)) return {};
  return Object.fromEntries(SELECTION_KEYS.filter((key) => value[key] !== undefined && value[key] !== null).map((key) => [key, value[key]]));
}

/** Fallbacks as the file keeps them: a bare ref of the flat form an object. */
function fallbacksOf(value: unknown): unknown {
  return Array.isArray(value) ? value.map((item) => (typeof item === "string" ? { model: item } : item)) : value;
}

function without(object: JsonObject, keys: Iterable<string>): JsonObject {
  const out = { ...object };
  for (const key of keys) delete out[key];
  return out;
}

/** The file's contents in the flat form the loader merges. */
export function flatFromFile(file: JsonObject): JsonObject {
  const flat = without(file, [...TOP_GROUPS, ...TOP.map(([key]) => key)]);
  for (const [key, path] of TOP) {
    const value = get(file, path);
    if (value !== undefined) flat[key] = value;
  }
  if (isObject(file.models) && isObject(file.models.default)) {
    const fileDefault = file.models.default;
    const flatDefault = without(fileDefault, ["fallbacks", "modelFallbacks"]);
    if (fileDefault.fallbacks !== undefined && fileDefault.fallbacks !== null) flatDefault.modelFallbacks = fileDefault.fallbacks;
    flat.models = { ...file.models, default: flatDefault };
  }
  if (isObject(file.agent)) {
    const fileAgent = file.agent;
    const agent = without(fileAgent, [...AGENT_GROUPS, ...AGENT_FLAT_KEYS]);
    for (const [route, path] of ROUTES) {
      const group = get(fileAgent, path);
      if (!isObject(group)) continue;
      const selection = selectionOf(group);
      if (Object.keys(selection).length > 0) agent[`${route}Model`] = selection;
      if (group.fallbacks !== undefined && group.fallbacks !== null) agent[`${route}ModelFallbacks`] = group.fallbacks;
    }
    for (const [key, path] of AGENT) {
      const value = get(fileAgent, path);
      if (value !== undefined) agent[key] = value;
    }
    flat.agent = agent;
  }
  return flat;
}

/** The flat form (Settings' patched file) in the file's groups. */
export function fileFromFlat(flat: JsonObject): JsonObject {
  const file = without(flat, TOP.map(([key]) => key));
  for (const [key, path] of TOP) {
    if (flat[key] !== undefined) set(file, path, flat[key]);
  }
  if (isObject(flat.models) && isObject(flat.models.default)) {
    const flatDefault = flat.models.default;
    const fileDefault = without(flatDefault, ["modelFallbacks"]);
    if (flatDefault.modelFallbacks !== undefined) fileDefault.fallbacks = fallbacksOf(flatDefault.modelFallbacks);
    file.models = { ...flat.models, default: fileDefault };
  }
  if (isObject(flat.agent)) {
    const flatAgent = flat.agent;
    const agent = without(flatAgent, AGENT_FLAT_KEYS);
    for (const [route, path] of ROUTES) {
      const group = selectionOf(flatAgent[`${route}Model`]);
      const fallbacks = flatAgent[`${route}ModelFallbacks`];
      if (fallbacks !== undefined && fallbacks !== null) group.fallbacks = fallbacksOf(fallbacks);
      if (Object.keys(group).length === 0) continue;
      const existing = get(agent, path);
      set(agent, path, isObject(existing) ? { ...existing, ...group } : group);
    }
    for (const [key, path] of AGENT) {
      if (flatAgent[key] !== undefined) set(agent, path, flatAgent[key]);
    }
    file.agent = agent;
  }
  return file;
}
