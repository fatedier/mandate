import { killPaneTool } from "./tools/kill-pane.js";
import { listPanesTool } from "./tools/list-panes.js";
import { paneStatusTool } from "./tools/pane-status.js";
import { buildReadPaneTool } from "./tools/read-pane.js";
import { sendKeysTool } from "./tools/send-keys.js";
import { setPaneMetadataTool } from "./tools/set-pane-metadata.js";
import { spawnPaneTool } from "./tools/spawn-pane.js";
import { toolPack, type ToolPack } from "../../runtime/tool-packs.js";
import type { PaneReadCursorStore } from "./pane-read-cursor.js";
import type { WindowWatchManager } from "../agent/window-watch-manager.js";

export function buildPaneToolPacks(deps: {
  cursors: PaneReadCursorStore;
  watchManager?: Pick<WindowWatchManager, "hasWatchForPane">;
}): ToolPack[] {
  return [
    toolPack("panes.feature", ["worker"], [
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
