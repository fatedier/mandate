import { tmuxPanePid } from "../../platform/tmux/tmux.js";
import { mountTerminalRoute } from "./terminal-route.js";
import type { WorkerToolPackContext, MandateModule } from "../module.js";
import { mountPaneRoutes } from "./pane-routes.js";
import { buildPaneToolPacks } from "./tool-packs.js";
import { paneReadCursors } from "./pane-read-cursor.js";
import { initializePanesSchema } from "./schema.js";

export const panesModule: MandateModule = {
  id: "panes",
  schema: [initializePanesSchema],
  mountRoutes: (app, { deps, upgradeWebSocket }) => {
    mountPaneRoutes(app, {
      projects: deps.projects,
      workers: deps.workers,
      tmuxClient: deps.tmuxClient,
      paneMetadata: deps.paneMetadata,
      getRawState: () => deps.poller.getRaw(),
      refreshWindows: (windowIds) => {
        void deps.pollTmux({ forceWindowIds: windowIds });
      }
    });
    mountTerminalRoute(app, upgradeWebSocket, {
      tmuxRuntime: deps.tmuxRuntime,
      panePid: (paneId) => tmuxPanePid(paneId, deps.tmuxClient)
    });
  },
  workerToolPacks: (ctx: WorkerToolPackContext) =>
    buildPaneToolPacks({ cursors: paneReadCursors, paneMonitorManager: ctx.paneMonitorManager })
};
