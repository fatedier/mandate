import { ACTIVITY_GROUP_KEYS, type ActivityGroupKey } from "@shared/api-contracts";

/** What the pill says for each dimension. A `Record`, so a dimension added to
 *  `ACTIVITY_GROUP_KEYS` cannot reach the selector unlabelled and one removed
 *  cannot leave a label behind: both are compile errors here. */
const GROUP_LABELS: Record<ActivityGroupKey, string> = {
  model: "provider / model",
  purpose: "purpose",
  scopeType: "scope type",
  day: "day",
  fallback: "fallback"
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
    case "model": {
      // Only the first separator: a model name may itself contain slashes, and
      // `codex/gpt-5.6-sol` is the common case rather than the exotic one.
      const at = key.indexOf(" / ");
      if (at < 0) return null;
      return { provider: key.slice(0, at), model: key.slice(at + 3) };
    }
    case "purpose": return { purpose: key };
    case "scopeType": return { scopeType: key };
    case "day": return { day: key };
    case "fallback": return { fallback: key === "fallback" ? "1" : "0" };
  }
}
