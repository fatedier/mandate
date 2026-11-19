import { isJsonObject, type JsonObject } from "./config-normalizers.js";
import {
  applyAgentPatch,
  applyMemoryPatch,
  applyModelsPatch,
  applyRetentionPatch,
  applyServerPatch,
  applyVoicePatch,
  pruneSettingsSections
} from "./config-section-patches.js";

import { applyWebSearchPatch, pruneWebSearchSection } from "../web/web-search-settings.js";
import { applyNotificationsPatch } from "../notifications/notifications-settings.js";

export * from "./config-normalizers.js";

export function applySettingsConfigPatch(
  current: JsonObject,
  payload: unknown
): JsonObject {
  if (!isJsonObject(payload)) throw new Error("settings payload must be an object");

  const next: JsonObject = { ...current };

  if (Object.hasOwn(payload, "models")) {
    applyModelsPatch(next, payload.models);
  }
  if (Object.hasOwn(payload, "server")) {
    applyServerPatch(next, payload.server);
  }
  if (Object.hasOwn(payload, "agent")) {
    applyAgentPatch(next, payload.agent);
  }
  if (Object.hasOwn(payload, "memory")) {
    applyMemoryPatch(next, payload.memory);
  }
  if (Object.hasOwn(payload, "voice")) {
    applyVoicePatch(next, payload.voice);
  }
  if (Object.hasOwn(payload, "webSearch")) {
    applyWebSearchPatch(next, payload.webSearch);
  }
  if (Object.hasOwn(payload, "retention")) {
    applyRetentionPatch(next, payload.retention);
  }
  if (Object.hasOwn(payload, "notifications")) {
    applyNotificationsPatch(next, payload.notifications);
  }
  pruneSettingsSections(next);
  pruneWebSearchSection(next);
  return next;
}
