import type { Config } from "../../config.js";
import { getCodexAuthStatus } from "../codex/codex-auth-store.js";

export function voiceConfigured(voice: Config["voice"]): boolean {
  if (voice.providerType === "codex") {
    return Boolean(voice.providerName && getCodexAuthStatus(voice.providerName).configured);
  }
  return Boolean(voice.apiKey);
}
