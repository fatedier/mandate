import { mountVoiceRoute } from "./voice-routes.js";
import type { MandateModule } from "../module.js";

export const voiceModule: MandateModule = {
  id: "voice",
  mountRoutes: (app, { deps, upgradeWebSocket }) =>
    mountVoiceRoute(app, upgradeWebSocket, { buildOrchestrator: deps.buildVoiceOrchestrator })
};
