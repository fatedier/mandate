import { ACTIVITY_GROUP_KEYS, type ActivityGroupDto, type ActivityGroupKey } from "@shared/api-contracts";
import { formatUsd } from "./money";

/** Each dimension's one name: its pill, the Breakdown tab's section title
 *  and the table's first column head all read it, in sentence case like
 *  every other pill. Here rather than beside the table so the component file
 *  exports only components (react-refresh). A `Record`, so a dimension added
 *  to `ACTIVITY_GROUP_KEYS` cannot reach the selector unlabelled and one
 *  removed cannot leave a label behind: both are compile errors here. */
export const GROUP_LABELS: Record<ActivityGroupKey, string> = {
  model: "Provider / model",
  purpose: "Purpose",
  scopeType: "Scope type",
  day: "Day",
  fallback: "Fallback"
};

/** Every dimension the endpoint groups by, in the endpoint's own order. Derived
 *  rather than listed again: a hand-written copy is what let the selector offer
 *  a cut the server had stopped answering. */
export const GROUP_OPTIONS: ReadonlyArray<{ id: ActivityGroupKey; label: string }> =
  ACTIVITY_GROUP_KEYS.map((id) => ({ id, label: GROUP_LABELS[id] }));

/** What a clicked row filters the log by, or null when the group is not a
 *  value the log can express. */
export function logFilterFor(
  group: ActivityGroupKey,
  key: string
): Record<string, string> | null {
  if (key === "(none)") return null;
  switch (group) {
    // `codex/gpt-5.6-sol` is the common case rather than the exotic one.
    case "model": return splitModelKey(key);
    case "purpose": return { purpose: key };
    case "scopeType": return { scopeType: key };
    case "day": return { day: key };
    case "fallback": return { fallback: key === "fallback" ? "1" : "0" };
  }
}

/** The provider and model a `provider / model` key names, or null when it is
 *  not one. Only the first separator: a model name may itself contain
 *  slashes. */
function splitModelKey(key: string): { provider: string; model: string } | null {
  const at = key.indexOf(" / ");
  return at < 0 ? null : { provider: key.slice(0, at), model: key.slice(at + 3) };
}

/**
 * The names a chart writes beside its marks, by group key. A model reads as
 * its own name, the part after its vendor (`anthropic/claude-opus-4-5` reads
 * `claude-opus-4-5`); where two groups would read the same, each carries
 * its provider. The full label stays on the mark's card and in its
 * accessible name. Other groupings read as the server labels them.
 */
export function shortGroupLabels(
  groups: ReadonlyArray<{ key: string; label: string }>,
  group: ActivityGroupKey
): Map<string, string> {
  if (group !== "model") return new Map(groups.map((entry) => [entry.key, entry.label]));
  const short = groups.map((entry) => {
    const parts = splitModelKey(entry.key);
    if (!parts) return { key: entry.key, name: entry.label, provider: null };
    return { key: entry.key, name: parts.model.slice(parts.model.lastIndexOf("/") + 1) || parts.model, provider: parts.provider };
  });
  const seen = new Map<string, number>();
  for (const entry of short) seen.set(entry.name, (seen.get(entry.name) ?? 0) + 1);
  return new Map(short.map((entry) => [
    entry.key,
    (seen.get(entry.name) ?? 0) > 1 && entry.provider ? `${entry.name} (${entry.provider})` : entry.name
  ]));
}

/** A group whose failed share reaches this is drawn in red on the map. */
export const ALERT_FAILED_SHARE = 0.1;

/** How many groups a ranked list shows. */
export const RANKED_TOP = 6;

/** One row of a ranked list: the bar's length is `value` against the
 *  list's first; `display` is the figure written beside it. */
export interface RankedRow {
  key: string;
  label: string;
  title: string;
  value: number;
  display: string;
}

/** The groups that spent the most, largest first; a group that spent
 *  nothing is not on it. */
export function spendRanking(groups: readonly ActivityGroupDto[], labels: ReadonlyMap<string, string>): RankedRow[] {
  return groups
    .filter((entry) => entry.spendMicros > 0)
    .sort((a, b) => b.spendMicros - a.spendMicros || b.calls - a.calls)
    .slice(0, RANKED_TOP)
    .map((entry) => ({
      key: entry.key,
      label: labels.get(entry.key) ?? entry.label,
      title: entry.label,
      value: entry.spendMicros,
      display: formatUsd(entry.spendMicros, entry.spendEstimated)
    }));
}

/** The groups that fail the most often, highest share first; a group with
 *  no failure is not on it. */
export function failRanking(groups: readonly ActivityGroupDto[], labels: ReadonlyMap<string, string>): RankedRow[] {
  return groups
    .filter((entry) => entry.failed > 0 && entry.calls > 0)
    .map((entry) => ({ entry, share: entry.failed / entry.calls }))
    .sort((a, b) => b.share - a.share || b.entry.calls - a.entry.calls)
    .slice(0, RANKED_TOP)
    .map(({ entry, share }) => ({
      key: entry.key,
      label: labels.get(entry.key) ?? entry.label,
      title: entry.label,
      value: share,
      display: `${(share * 100).toFixed(1)}%`
    }));
}
