import type { z } from "zod";
import * as agentAlarmTools from "./tools/alarm-tools-schema.js";
import * as agentBash from "./tools/bash-schema.js";
import * as agentChatHistory from "./tools/chat-history-schema.js";
import * as agentEditFile from "./tools/edit-file-schema.js";
import * as agentWorkerMessageTools from "./tools/worker-message-tools-schema.js";
import * as agentMonitor from "./tools/monitor-schema.js";
import * as agentQuestionTools from "./tools/question-tools-schema.js";
import * as agentReadFile from "./tools/read-file-schema.js";
import * as agentReadThread from "./tools/read-thread-schema.js";
import * as agentSubagentTools from "./tools/subagent-tools-schema.js";
import * as agentSweepTools from "./tools/sweep-tools-schema.js";
import * as agentThreadTools from "./tools/thread-tools-schema.js";
import * as agentViewImage from "./tools/view-image-schema.js";
import * as agentWorkItemTools from "./tools/work-item-tools-schema.js";
import * as agentWriteFile from "./tools/write-file-schema.js";
import * as canvasToolPacks from "../canvas/tool-packs-schema.js";
import * as workersArchiveWorker from "../workers/tools/archive-worker-schema.js";
import * as workersCreateWorker from "../workers/tools/create-worker-schema.js";
import * as workersGetWorkerStatus from "../workers/tools/get-worker-status-schema.js";
import * as workersListWorkers from "../workers/tools/list-workers-schema.js";
import * as workersReadWorkerThread from "../workers/tools/read-worker-thread-schema.js";
import * as workersRestoreWorker from "../workers/tools/restore-worker-schema.js";
import * as personalPersonalTools from "../personal/personal-tools-schema.js";
import * as memoryDream from "../memory/dream-schema.js";
import * as memoryMemory from "../memory/tools/memory-schema.js";
import * as notificationsNotifyTool from "../notifications/notify-tool-schema.js";
import * as panesKillPane from "../panes/tools/kill-pane-schema.js";
import * as panesListPanes from "../panes/tools/list-panes-schema.js";
import * as panesPaneStatus from "../panes/tools/pane-status-schema.js";
import * as panesReadPane from "../panes/tools/read-pane-schema.js";
import * as panesSendKeys from "../panes/tools/send-keys-schema.js";
import * as panesSetPaneMetadata from "../panes/tools/set-pane-metadata-schema.js";
import * as panesSpawnPane from "../panes/tools/spawn-pane-schema.js";
import * as plansPlanTools from "../plans/plan-tools-schema.js";
import * as projectsArchiveProject from "../projects/tools/archive-project-schema.js";
import * as projectsCreateProject from "../projects/tools/create-project-schema.js";
import * as projectsListProjects from "../projects/tools/list-projects-schema.js";
import * as schedulesScheduleTools from "../schedules/tools/schedule-tools-schema.js";
import * as taskBoardTaskBoardTools from "../task-board/tools/task-board-tools-schema.js";
import * as stickyNotesStickyNotesTools from "../sticky-notes/tools/sticky-notes-tools-schema.js";
import * as calendarCalendarTools from "../calendar/tools/calendar-tools-schema.js";
import * as skillsSkillReferenceTool from "../skills/skill-reference-tool-schema.js";
import * as skillsSkillTool from "../skills/skill-tool-schema.js";
import * as skillsManageSkill from "../skills/manage-skill-schema.js";
import * as skillsRequestSkillReviewTool from "../skills/request-skill-review-tool-schema.js";
import * as webWebFetchTool from "../web/web-fetch-tool-schema.js";
import * as webWebSearchTool from "../web/web-search-tool-schema.js";

/**
 * Every tool's input schema, by "<module>.<export>": the same zod objects the
 * tools are registered with, from modules that hold nothing but schemas, so
 * another thread (the model-call worker) can import them and validate a
 * model's tool calls exactly as the SDK does here. A tool registered with a
 * schema that is not here simply keeps its steps on this thread.
 */
const MODULES: Record<string, Record<string, unknown>> = {
  "agent/alarm-tools": agentAlarmTools,
  "agent/bash": agentBash,
  "agent/chat-history": agentChatHistory,
  "agent/edit-file": agentEditFile,
  "agent/worker-message-tools": agentWorkerMessageTools,
  "agent/monitor": agentMonitor,
  "agent/question-tools": agentQuestionTools,
  "agent/read-file": agentReadFile,
  "agent/read-thread": agentReadThread,
  "agent/subagent-tools": agentSubagentTools,
  "agent/sweep-tools": agentSweepTools,
  "agent/thread-tools": agentThreadTools,
  "agent/view-image": agentViewImage,
  "agent/work-item-tools": agentWorkItemTools,
  "agent/write-file": agentWriteFile,
  "canvas/tool-packs": canvasToolPacks,
  "workers/archive-worker": workersArchiveWorker,
  "workers/create-worker": workersCreateWorker,
  "workers/get-worker-status": workersGetWorkerStatus,
  "workers/list-workers": workersListWorkers,
  "workers/read-worker-thread": workersReadWorkerThread,
  "workers/restore-worker": workersRestoreWorker,
  "personal/personal-tools": personalPersonalTools,
  "memory/dream": memoryDream,
  "memory/memory": memoryMemory,
  "notifications/notify-tool": notificationsNotifyTool,
  "panes/kill-pane": panesKillPane,
  "panes/list-panes": panesListPanes,
  "panes/pane-status": panesPaneStatus,
  "panes/read-pane": panesReadPane,
  "panes/send-keys": panesSendKeys,
  "panes/set-pane-metadata": panesSetPaneMetadata,
  "panes/spawn-pane": panesSpawnPane,
  "plans/plan-tools": plansPlanTools,
  "projects/archive-project": projectsArchiveProject,
  "projects/create-project": projectsCreateProject,
  "projects/list-projects": projectsListProjects,
  "schedules/schedule-tools": schedulesScheduleTools,
  "task-board/task-board-tools": taskBoardTaskBoardTools,
  "sticky-notes/sticky-notes-tools": stickyNotesStickyNotesTools,
  "calendar/calendar-tools": calendarCalendarTools,
  "skills/skill-reference-tool": skillsSkillReferenceTool,
  "skills/skill-tool": skillsSkillTool,
  "skills/manage-skill": skillsManageSkill,
  "skills/request-skill-review-tool": skillsRequestSkillReviewTool,
  "web/web-fetch-tool": webWebFetchTool,
  "web/web-search-tool": webWebSearchTool,
};

const isSchema = (value: unknown): value is z.ZodType<unknown> =>
  typeof value === "object" && value !== null && typeof (value as { safeParse?: unknown }).safeParse === "function";

export const TOOL_INPUT_SCHEMAS: Readonly<Record<string, z.ZodType<unknown>>> = Object.freeze(Object.fromEntries(
  Object.entries(MODULES).flatMap(([module, exported]) =>
    Object.entries(exported).filter(([, value]) => isSchema(value)).map(([name, value]) => [`${module}.${name}`, value as z.ZodType<unknown>]))
));

const KEYS = new Map<unknown, string>(Object.entries(TOOL_INPUT_SCHEMAS).map(([key, schema]) => [schema, key]));

/** The catalog key of a schema object, when it is one of the catalog's. */
export function toolSchemaKey(schema: z.ZodType<unknown>): string | undefined {
  return KEYS.get(schema);
}
