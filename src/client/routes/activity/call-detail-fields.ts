import { formatCallDurationMs } from "./activity-model";
import { apiLabelForCall, providerNameForCall } from "./format";
import type { ActivityCallDetail } from "./types";

interface CallDetailField {
  label: string;
  value: string;
  /** An identifier (model, hash, url) in mono; anything else in the body font. */
  mono: boolean;
}

/**
 * The fields the detail panel shows above the raw payloads.
 *
 * A plain module rather than a helper inside the component, so a test can
 * call it on a call's metadata after retention has reduced it (`phase` must
 * still be there).
 */
export function buildCallDetailFields(detail: ActivityCallDetail): CallDetailField[] {
  const scope = detail.scopeId
    ? `${detail.scopeType ?? ""} · ${detail.scopeId}`
    : detail.scopeType ?? "";
  const metadata = detail.metadata as Record<string, unknown> | null | undefined;
  const phase = metadata && typeof metadata.phase === "string" ? metadata.phase : "";
  const candidates: Array<Omit<CallDetailField, "mono"> & { mono?: boolean }> = [
    {
      label: "provider name",
      value: providerNameForCall(detail)
    },
    // The API the call spoke; the family the server runs a model as is an
    // internal name (anthropic, openai-compatible, kilo) and stays out.
    { label: "API", value: apiLabelForCall(detail) },
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
    { label: "base url", value: detail.baseURL ?? "" },
    { label: "request hash", value: detail.requestHash },
    { label: "response hash", value: detail.responseHash }
  ];
  // A field with nothing in it is noise in a grid that is already three
  // columns wide.
  return candidates
    .filter((candidate) => candidate.value.trim().length > 0)
    .map((candidate) => ({ ...candidate, mono: candidate.mono ?? true }));
}
