import type { AppDeps } from "../../app/deps.js";
import {
  API_ROUTES,
  type AppInfoResponse,
  type AppStateResponse
} from "../../../shared/api-contracts.js";
import { getCodexAuthStatus } from "../codex/codex-auth-store.js";
import type { MandateModule } from "../module.js";

export const stateModule: MandateModule = {
  id: "state",
  mountRoutes: (app, { deps }) => {
    // Current tmux snapshot + last error + projects DTO.
    // Uses the same projectsState computation as the SSE broadcast.
    app.get(API_ROUTES.state, (c) => {
      const response = {
        snapshot: deps.poller.getSnapshot(),
        error: deps.poller.getLastError(),
        projects: deps.getProjectsState()
      } satisfies AppStateResponse;
      return c.json(response);
    });

    // HEAD is a readiness check for the settings restart flow; GET returns config.
    app.get(API_ROUTES.info, (c) => {
      c.header("Cache-Control", "no-store");
      // Hono dispatches HEAD through GET, so skip config/auth work explicitly.
      if (c.req.method === "HEAD") return c.body(null, 200);
      const response = {
        server: {
          port: deps.config.port,
          pollIntervalMs: deps.config.pollIntervalMs,
          captureLines: deps.config.captureLines
        },
        voice: {
          provider: deps.config.voice.provider,
          model: deps.config.voice.model,
          voice: deps.config.voice.voice,
          language: deps.config.voice.language,
          idleTimeoutMs: deps.config.voice.idleTimeoutMs,
          maxSessionMs: deps.config.voice.maxSessionMs,
          configured: voiceConfigured(deps.config.voice),
          baseURL: deps.config.voice.baseURL,
          deployment: deps.config.voice.deployment
        }
      } satisfies AppInfoResponse;
      return c.json(response);
    });
  }
};

function voiceConfigured(voice: AppDeps["config"]["voice"]) {
  if (voice.providerType === "codex") {
    return Boolean(voice.providerName && getCodexAuthStatus(voice.providerName).configured);
  }
  return Boolean(voice.apiKey);
}
