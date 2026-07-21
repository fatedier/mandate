import type { AppStateResponse, SseEventPayloadMap } from "@shared/api-contracts";

/** Parse a Server-Sent Event's `data` field. SSE delivers raw text; we ship
 *  JSON. Reused by every listener so the cast lives in one place. */
export function parseSseData<T>(event: Event): T {
  return JSON.parse((event as MessageEvent).data) as T;
}

/** Pure descriptor of what to apply from an AppStateResponse. Each property is
 *  set only when the input actually provides that piece. */
export interface AppStateMutations {
  snapshot?: AppStateResponse["snapshot"];
  banner?: string;
  projects?: SseEventPayloadMap["projectsState"];
}

export function appStateMutations(payload: AppStateResponse): AppStateMutations {
  const mutations: AppStateMutations = {};
  if (payload.snapshot) mutations.snapshot = payload.snapshot;
  if (payload.error) {
    mutations.banner =
      typeof payload.error === "string"
        ? payload.error
        : payload.error.message ?? String(payload.error);
  }
  if (Array.isArray(payload.projects)) {
    mutations.projects = payload.projects;
  }
  return mutations;
}
