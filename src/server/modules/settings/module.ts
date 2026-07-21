import { mountSettingsRoutes } from "./settings-routes.js";
import { globalHttpClient } from "../../platform/http/http-client.js";
import type { MandateModule } from "../module.js";

export const settingsModule: MandateModule = {
  id: "settings",
  mountRoutes: (app, { deps }) => mountSettingsRoutes(app, {
    reloadConfig: deps.reloadConfig,
    store: deps.store,
    config: deps.config,
    // Live provider model listing; tests construct the service without a
    // client and stay on the configured-only path by design.
    httpClient: globalHttpClient
  })
};
