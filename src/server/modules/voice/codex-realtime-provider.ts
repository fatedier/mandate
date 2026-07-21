import { resolveCodexAccess, type CodexAuthProfile } from "../codex/codex-auth-store.js";
import { CODEX_USER_AGENT } from "../codex/codex-http.js";
import {
  OpenAIRealtimeProvider,
  type OpenAIRealtimeProviderDeps
} from "./openai-realtime-provider.js";

const DEFAULT_CODEX_REALTIME_URL = "wss://api.openai.com/v1/realtime";

export interface CodexRealtimeProviderDeps extends Omit<OpenAIRealtimeProviderDeps, "resolveAuthHeaders"> {
  resolveAccess?: (providerName: string) => Promise<CodexAuthProfile>;
}

export class CodexRealtimeProvider extends OpenAIRealtimeProvider {
  constructor(deps: CodexRealtimeProviderDeps = {}) {
    const resolveAccess = deps.resolveAccess ?? resolveCodexAccess;
    super({
      ...deps,
      baseURL: deps.baseURL ?? DEFAULT_CODEX_REALTIME_URL,
      resolveAuthHeaders: async (config) => {
        const providerName = config.providerName?.trim();
        if (!providerName) {
          throw new Error("Codex voice provider requires a configured provider name.");
        }
        const profile = await resolveAccess(providerName);
        const headers: Record<string, string> = {
          Authorization: `Bearer ${profile.access}`,
          "User-Agent": CODEX_USER_AGENT,
          originator: "mandate"
        };
        if (profile.accountId) {
          headers["ChatGPT-Account-Id"] = profile.accountId;
        }
        return headers;
      }
    });
  }
}
