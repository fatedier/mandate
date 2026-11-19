import { killPaneTool } from "./tools/kill-pane.js";
import { listPanesTool } from "./tools/list-panes.js";
import { paneStatusTool } from "./tools/pane-status.js";
import { buildReadPaneTool } from "./tools/read-pane.js";
import { sendKeysTool } from "./tools/send-keys.js";
import { setPaneMetadataTool } from "./tools/set-pane-metadata.js";
import { spawnPaneTool } from "./tools/spawn-pane.js";
import { toolPack, type ToolPack } from "../../runtime/tool-packs.js";
import type { PaneReadCursorStore } from "./pane-read-cursor.js";
import type { PaneMonitorManager } from "../agent/pane-monitor-manager.js";

export function buildPaneToolPacks(deps: {
  cursors: PaneReadCursorStore;
  paneMonitorManager?: Pick<PaneMonitorManager, "hasMonitorForPane">;
}): ToolPack[] {
  return [
    toolPack("panes.worker", ["worker"], [
      listPanesTool,
      paneStatusTool,
      spawnPaneTool,
      setPaneMetadataTool,
      sendKeysTool,
      buildReadPaneTool(deps),
      killPaneTool
    ])
  ];
}
