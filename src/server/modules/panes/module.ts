import { mountTerminalRoute } from "./terminal-route.js";
import type { WorkerToolPackContext, MandateModule } from "../module.js";
import { mountPaneRoutes } from "./pane-routes.js";
import { buildPaneToolPacks } from "./tool-packs.js";
import { paneReadCursors } from "./pane-read-cursor.js";
import { initializePanesSchema } from "./schema.js";
import { panesMigrations } from "./migrations.js";

export const panesModule: MandateModule = {
  id: "panes",
  schema: [initializePanesSchema],
  migrations: panesMigrations,
  mountRoutes: (app, { deps, upgradeWebSocket }) => {
    mountPaneRoutes(app, {
      projects: deps.projects,
      features: deps.features,
      tmuxClient: deps.tmuxClient,
      paneMetadata: deps.paneMetadata,
      getRawState: () => deps.poller.getRaw(),
      refreshWindows: (windowIds) => {
        void deps.pollTmux({ forceWindowIds: windowIds });
      }
    });
    mountTerminalRoute(app, upgradeWebSocket, { paneRuntimes: deps.paneRuntimes });
  },
  workerToolPacks: (ctx: WorkerToolPackContext) =>
    buildPaneToolPacks({ cursors: paneReadCursors, watchManager: ctx.watchManager })
};
