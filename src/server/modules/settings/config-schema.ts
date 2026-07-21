import { isJsonObject, type JsonObject, type ProviderAuthRename } from "./config-normalizers.js";
import {
  applyAgentPatch,
  applyMemoryPatch,
  applyModelsPatch,
  applyServerPatch,
  applyVoicePatch,
  pruneSettingsSections
} from "./config-section-patches.js";

export * from "./config-normalizers.js";

export function applySettingsConfigPatch(
  current: JsonObject,
  payload: unknown
): { next: JsonObject; authRenames: ProviderAuthRename[] } {
  if (!isJsonObject(payload)) throw new Error("settings payload must be an object");

  const next: JsonObject = { ...current };
  const authRenames: ProviderAuthRename[] = [];

  if (Object.hasOwn(payload, "models")) {
    applyModelsPatch(next, payload.models, authRenames);
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
  pruneSettingsSections(next);
  return { next, authRenames };
}
