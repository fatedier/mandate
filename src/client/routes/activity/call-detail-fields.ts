import {
  featureEventStatus,
  firstFeatureEventFromCallMetadata,
  formatFeatureEventSourceLabel
} from "@/lib/feature-event-source";
import { formatCallDurationMs } from "./activity-model";
import { providerNameForCall } from "./format";
import type { ActivityCallDetail } from "./types";

export interface CallDetailField {
  label: string;
  value: string;
}

/**
 * The fields the detail panel shows above the raw payloads.
 *
 * A plain module rather than a helper inside the component, because this is
 * also the list `retention.ts` keeps `metadata_json` keys for — `phase`, and
 * whatever `firstFeatureEventFromCallMetadata` needs — and that guard should
 * rest on something a test can call.
 */
export function buildCallDetailFields(detail: ActivityCallDetail): CallDetailField[] {
  const scope = detail.scopeId
    ? `${detail.scopeType ?? ""} · ${detail.scopeId}`
    : detail.scopeType ?? "";
  const metadata = detail.metadata as Record<string, unknown> | null | undefined;
  const phase = metadata && typeof metadata.phase === "string" ? metadata.phase : "";
  const featureEvent = firstFeatureEventFromCallMetadata(detail.metadata);
  const candidates: CallDetailField[] = [
    {
      label: detail.matchedProviderName ? "provider name (current config)" : "provider name",
      value: providerNameForCall(detail)
    },
    { label: "provider type", value: detail.provider },
    { label: "model", value: detail.model ?? "" },
    // Tokens are deliberately absent: they are two containments rather than one
    // value, so they get their own block. See `tokenBreakdown`.
    // Empty when the call predates the column or the provider never answered,
    // and the builder drops empty fields — so an old call shows no row at all
    // rather than a zero that reads as an instant first token.
    {
      label: "TTFT",
      value: detail.ttftMs === null || detail.ttftMs === undefined
        ? ""
        : formatCallDurationMs(detail.ttftMs)
    },
    { label: "scope", value: scope },
    { label: "phase", value: phase },
    { label: "parent", value: detail.parentCallId ?? "" },
    { label: "base url", value: detail.baseURL ?? "" },
    {
      label: "feature event",
      value: featureEvent
        ? [featureEventStatus(featureEvent), featureEvent.label].filter(Boolean).join(" · ")
        : ""
    },
    { label: "source", value: formatFeatureEventSourceLabel(featureEvent?.source) ?? "" },
    { label: "request hash", value: detail.requestHash },
    { label: "response hash", value: detail.responseHash }
  ];
  // A field with nothing in it is noise in a grid that is already three
  // columns wide.
  return candidates.filter((candidate) => candidate.value.trim().length > 0);
}
