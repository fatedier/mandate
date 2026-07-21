import type {
  UiLocation,
  UiSummaryResponsePayload
} from "../ui-context.js";
import type { ApiErrorResponse } from "./common.js";

export type {
  UiLocation,
  UiPageSummary,
  UiRouteKind,
  UiSummaryRequestPayload,
  UiSummaryResponsePayload
} from "../ui-context.js";

export type UiLocationRequest = UiLocation | {
  location: UiLocation;
};

export type UiPageSummaryRequest = UiSummaryResponsePayload;

export type UiContextWriteResponse = {
  ok: true;
} | ApiErrorResponse;
