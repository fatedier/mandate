import type { ApiErrorResponse } from "./common.js";

export interface WindowInspectRequest {
  windowId: string;
}

export type WindowInspectResponse = {
  ok: true;
  snapshot: unknown | null;
} | ApiErrorResponse;

