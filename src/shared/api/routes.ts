export const API_ROUTES = {
  events: "/api/events",
  activityCalls: "/api/activity/calls",
  activityCall: "/api/activity/calls/:id",
  activitySummary: "/api/activity/summary",
  activityFilterOptions: "/api/activity/filter-options",
  /** POST a PresenceReport: where a window is, for where notices go. */
  notificationsPresence: "/api/notifications/presence",
  /** POST {channelId} or {channel}: sends a test notice. */
  notificationsTest: "/api/notifications/test",
  /** POST {channelId?, botToken?}: finds the chat the user opened with their bot. */
  notificationsTelegramConnect: "/api/notifications/telegram/connect",
  pricingProvider: "/api/pricing/providers/:name",
  pricingMatch: "/api/pricing/match",
  pricingCatalog: "/api/pricing/catalog",
  pricingStatus: "/api/pricing/status",
  agentActiveWakes: "/api/agents/active-wakes",
  agentPendingMonitors: "/api/agents/pending-monitors",
  agentWorker: "/api/agents/workers/:workerId",
  agentManagerThreads: "/api/agents/manager/threads",
  agentManagerThread: "/api/agents/manager/threads/:threadId",
  agentManagerThreadSeen: "/api/agents/manager/threads/:threadId/seen",
  agentManagerThreadLabels: "/api/agents/manager/threads/:threadId/labels",
  agentManagerThreadLabel: "/api/agents/manager/threads/:threadId/labels/:name",
  agentManagerThreadWorkers: "/api/agents/manager/threads/:threadId/workers",
  /** A thread's canvases: its manager's and its workers', archived ones too. */
  agentManagerThreadCanvases: "/api/agents/manager/threads/:threadId/canvases",
  agentWakeCancel: "/api/agents/wakes/:wakeId/cancel",
  agentWakeRetry: "/api/agents/wakes/:wakeId/retry",
  agentThread: "/api/agents/threads/:threadId",
  agentThreadMessages: "/api/agents/threads/:threadId/messages",
  agentThreadMessage: "/api/agents/threads/:threadId/messages/:messageId",
  agentMessageImage: "/api/agents/messages/:messageId/images/:imageId",
  agentThreadQueuedMessage: "/api/agents/threads/:threadId/queued-messages/:clientRequestId",
  agentThreadCommands: "/api/agents/threads/:threadId/commands",
  agentThreadModel: "/api/agents/threads/:threadId/model",
  /** GET / POST {messageId, text}: the replies opened in the thread's right panel. */
  agentThreadReplyTabs: "/api/agents/threads/:threadId/reply-tabs",
  /** DELETE: one of them closed, on every device. */
  agentThreadReplyTab: "/api/agents/threads/:threadId/reply-tabs/:tabId",
  agentThreadQuestionSkip: "/api/agents/threads/:threadId/questions/:questionId/skip",
  /** GET: a conversation's background tasks, newest first. */
  agentThreadTasks: "/api/agents/threads/:threadId/tasks",
  /** POST: the user stops a background task. */
  agentTaskStop: "/api/agents/tasks/:taskId/stop",
  agentTask: "/api/agents/tasks/:taskId",
  agentPersonal: "/api/agents/personal",
  /** POST: a new side chat, forked from the personal agent's conversation; GET: the open ones. */
  sideChats: "/api/agents/personal/side-chats",
  /** PATCH {title}: renamed; DELETE: discarded. */
  sideChat: "/api/agents/personal/side-chats/:id",
  /** POST {seq}: seen up to seq. */
  sideChatSeen: "/api/agents/personal/side-chats/:id/seen",
  /** POST: its summary for the main conversation, written now and kept nowhere. */
  sideChatSummary: "/api/agents/personal/side-chats/:id/summary",
  /** POST {summary, note}: sent to the main conversation; the side chat ends. */
  sideChatSend: "/api/agents/personal/side-chats/:id/send",
  /** GET (?deleted=1 for the deleted ones) / POST {title, description?, dueDate?, dueTime?}: the owner's task board. */
  taskBoardTasks: "/api/task-board/tasks",
  /** GET: one task with its stream; PATCH {title?, description?, dueDate?, dueTime?, status?}; DELETE: to Recently deleted. */
  taskBoardTask: "/api/task-board/tasks/:id",
  /** POST: back from Recently deleted. */
  taskBoardRestore: "/api/task-board/tasks/:id/restore",
  /** DELETE: a task in Recently deleted, gone for good (409 for one on the board). */
  taskBoardForever: "/api/task-board/tasks/:id/forever",
  /** POST {text, mentions?}: the owner's comment. */
  taskBoardComments: "/api/task-board/tasks/:id/comments",
  /** POST: the owner has the task open in front of them (what waits on them there is seen). */
  taskBoardOpened: "/api/task-board/tasks/:id/opened",
  /** POST {name}: the owner's label on the task. */
  taskBoardLabels: "/api/task-board/tasks/:id/labels",
  /** DELETE: a label off the task. */
  taskBoardLabel: "/api/task-board/tasks/:id/labels/:name",
  /** DELETE: every Done task to Recently deleted. */
  taskBoardDone: "/api/task-board/done",
  /** GET: the open sticky notes and the newest done ones. */
  stickyNotes: "/api/sticky-notes",
  /** POST: the user marked the note done. */
  stickyNoteDone: "/api/sticky-notes/:id/done",
  /** POST: a done note back on the wall. */
  stickyNoteRestore: "/api/sticky-notes/:id/restore",
  /** POST {notes: [{id, version}]}: these notes, as they were then, were shown to the user. */
  stickyNotesSeen: "/api/sticky-notes/seen",
  /** GET ?from=<ms>&to=<ms>: the calendar's entries and its times in that range. */
  calendar: "/api/calendar",
  /** POST: the user paused a repeat. */
  calendarPause: "/api/calendar/:id/pause",
  /** POST: the user resumed it. */
  calendarResume: "/api/calendar/:id/resume",
  /** POST {at}: the user skipped one due time of a repeat. */
  calendarSkip: "/api/calendar/:id/skip",
  /** DELETE: the user deleted the entry. */
  calendarEntry: "/api/calendar/:id",
  agentPersonalHandoffs: "/api/agents/personal/handoffs",
  agentPersonalSeen: "/api/agents/personal/seen",
  /** GET / POST {threadId}: the threads opened beside the personal agent, in its right panel. */
  agentPersonalThreadTabs: "/api/agents/personal/thread-tabs",
  /** DELETE: one of them closed, on every device. */
  agentPersonalThreadTab: "/api/agents/personal/thread-tabs/:threadId",
  /** GET: Personal agent's page — its latest version's stamp and the page subagent's write. */
  agentPage: "/api/agent-page",
  /** GET: one version of the page, with the HTML of its pages. */
  agentPageVersion: "/api/agent-page/versions/:revision",
  /** GET: a file of one version, by its path in the page's folder. */
  agentPageFile: "/api/agent-page/files/:revision/:filePath{.+}",
  /** GET: the latest value of a built-in or listed source. */
  agentPageData: "/api/agent-page/data/:name",
  /** POST: something the user gave on the page. */
  agentPageAnswers: "/api/agent-page/answers",
  /** GET: the sources the page listed. */
  agentPageSources: "/api/agent-page/sources",
  /** PATCH {paused} / DELETE: the user pauses, resumes or removes a source. */
  agentPageSource: "/api/agent-page/sources/:name",
  /** GET: the scheduled updates the page listed. */
  agentPageUpdates: "/api/agent-page/updates",
  /** PATCH {paused} / DELETE: the user pauses, resumes or removes an update. */
  agentPageUpdate: "/api/agent-page/updates/:name",
  /** GET: a schedule's last checks, newest first. Schedules change through
   *  the personal agent; the owner may only pause, resume or run one now (below). */
  scheduleRuns: "/api/schedules/:id/runs",
  /** POST: the owner pauses, resumes or runs a schedule now (the On duty page). */
  schedulePause: "/api/schedules/:id/pause",
  scheduleResume: "/api/schedules/:id/resume",
  scheduleRun: "/api/schedules/:id/run",
  /** PUT / DELETE: a duty thread in or out of the owner's sidebar. */
  dutySidebar: "/api/agents/manager/threads/:threadId/sidebar",
  canvasById: "/api/canvas/:id",
  canvasTitles: "/api/canvases/titles",
  canvasMentions: "/api/canvases/mentions",
  canvasAssets: "/api/canvas/:id/assets/:assetPath{.+}",
  /** GET ?path=<absolute>&part=start|end&line=<n>: a file an agent linked (FileDto). */
  files: "/api/files",
  /** GET ?path=<absolute>: an image's or a PDF's bytes. */
  fileRaw: "/api/files/raw",
  /** GET ?path=<absolute>: any file's bytes, as an attachment under its own name. */
  fileDownload: "/api/files/download",
  /** POST {path}: a copy of the file put in the Downloads folder (SharedFileSaved), for the desktop app. */
  fileSave: "/api/files/save",
  /** POST a PNG or Markdown body: written into the Downloads folder (SharedFileSaved). */
  shareFiles: "/api/share-files",
  workerCanvases: "/api/workers/:id/canvases",
  workerPlan: "/api/workers/:id/plan",
  workerRecord: "/api/workers/:id/record",
  info: "/api/info",
  memoryBriefs: "/api/memory/briefs",
  memoryDreamRuns: "/api/memory/dream/runs",
  memoryDreamRun: "/api/memory/dream/runs/:id",
  memoryEntries: "/api/memory/entries",
  memoryEntryHistory: "/api/memory/entries/:id/history",
  memoryStats: "/api/memory/stats",
  paneById: "/api/panes/:paneId",
  paneSplit: "/api/panes/:paneId/split",
  workerChanges: "/api/workers/:workerId/changes",
  workerChangesFile: "/api/workers/:workerId/changes/file",
  projects: "/api/projects",
  projectReorder: "/api/projects/reorder",
  projectById: "/api/projects/:id",
  projectWorkers: "/api/projects/:projectId/workers",
  projectReconcile: "/api/projects/:id/reconcile",
  /** GET ?limit=n: the project's newest canvases and how many it has. */
  projectCanvases: "/api/projects/:id/canvases",
  skills: "/api/skills",
  skillsRefresh: "/api/skills/refresh",
  /** GET ?scope=global|project&projectId=&status=available|archived: learned skills, read only. */
  learnedSkills: "/api/skills/learned",
  learnedSkill: "/api/skills/learned/:id",
  learnedSkillRevision: "/api/skills/learned/:id/revisions/:revision",
  /** GET: the newest requested skill reviews. */
  skillReviews: "/api/skills/reviews",
  terminal: "/api/terminal",
  /** GET: every tmux session and the pins; POST: a new shell. */
  terminals: "/api/terminals",
  /** POST { paneId, pid }: pin a pane. */
  terminalPins: "/api/terminals/pins",
  /** PUT { pins: [{ paneId, pid }] }: the pins in the order dragged into. */
  terminalPinsOrder: "/api/terminals/pins/order",
  /** DELETE: unpin a pane. */
  terminalPin: "/api/terminals/pins/:paneId",
  /** GET: one window's panes and layout, by tmux window id. */
  terminalWindow: "/api/terminals/windows/:windowId",
  tmuxSessions: "/api/tmux/sessions",
  voiceWs: "/api/voice/ws",
  windowInspect: "/api/windows/inspect",
  workerById: "/api/workers/:id",
  workerArchiveCheck: "/api/workers/:id/archive-check",
  workerPin: "/api/workers/:id/pin",
  workerPanes: "/api/workers/:id/panes",
  settingsConfig: "/api/settings/config",
  setupStatus: "/api/setup/status",
  codexAuthStart: "/api/settings/auth/codex/start",
  codexAuthStatus: "/api/settings/auth/codex/status",
  codexAuthLogout: "/api/settings/auth/codex/logout",
  settingsProviderModels: "/api/settings/providers/:providerName/models",
  settingsProviderCheck: "/api/settings/providers/:providerName/check",
  settingsWebSearchCheck: "/api/settings/web-search/check",
  storageStatus: "/api/storage",
  storageCleanup: "/api/storage/cleanup",
  workItems: "/api/work-items",
  workItemAcknowledge: "/api/work-items/:id/acknowledge"
} as const;

export const API_PATHS = {
  activityCall: (id: string) => `/api/activity/calls/${encodeURIComponent(id)}`,
  pricingProvider: (name: string) => `/api/pricing/providers/${encodeURIComponent(name)}`,
  agentWorker: (workerId: string) => `/api/agents/workers/${encodeURIComponent(workerId)}`,
  agentManagerThread: (threadId: string) => `/api/agents/manager/threads/${encodeURIComponent(threadId)}`,
  agentManagerThreadSeen: (threadId: string) => `/api/agents/manager/threads/${encodeURIComponent(threadId)}/seen`,
  agentManagerThreadLabels: (threadId: string) => `/api/agents/manager/threads/${encodeURIComponent(threadId)}/labels`,
  agentManagerThreadLabel: (threadId: string, name: string) =>
    `/api/agents/manager/threads/${encodeURIComponent(threadId)}/labels/${encodeURIComponent(name)}`,
  agentManagerThreadWorkers: (threadId: string) => `/api/agents/manager/threads/${encodeURIComponent(threadId)}/workers`,
  agentManagerThreadCanvases: (threadId: string) => `/api/agents/manager/threads/${encodeURIComponent(threadId)}/canvases`,
  agentWakeCancel: (wakeId: string) => `/api/agents/wakes/${encodeURIComponent(wakeId)}/cancel`,
  agentWakeRetry: (wakeId: string) => `/api/agents/wakes/${encodeURIComponent(wakeId)}/retry`,
  agentThread: (threadId: string) => `/api/agents/threads/${encodeURIComponent(threadId)}`,
  agentThreadMessages: (threadId: string) => `/api/agents/threads/${encodeURIComponent(threadId)}/messages`,
  agentThreadMessage: (threadId: string, messageId: string) =>
    `/api/agents/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
  agentMessageImage: (messageId: string, imageId: string) =>
    `/api/agents/messages/${encodeURIComponent(messageId)}/images/${encodeURIComponent(imageId)}`,
  agentThreadQueuedMessage: (threadId: string, clientRequestId: string) =>
    `/api/agents/threads/${encodeURIComponent(threadId)}/queued-messages/${encodeURIComponent(clientRequestId)}`,
  agentThreadCommands: (threadId: string) => `/api/agents/threads/${encodeURIComponent(threadId)}/commands`,
  agentThreadModel: (threadId: string) => `/api/agents/threads/${encodeURIComponent(threadId)}/model`,
  agentThreadReplyTabs: (threadId: string) => `/api/agents/threads/${encodeURIComponent(threadId)}/reply-tabs`,
  agentThreadReplyTab: (threadId: string, tabId: string) =>
    `/api/agents/threads/${encodeURIComponent(threadId)}/reply-tabs/${encodeURIComponent(tabId)}`,
  agentPersonalThreadTab: (threadId: string) => `/api/agents/personal/thread-tabs/${encodeURIComponent(threadId)}`,
  agentThreadQuestionSkip: (threadId: string, questionId: string) =>
    `/api/agents/threads/${encodeURIComponent(threadId)}/questions/${encodeURIComponent(questionId)}/skip`,
  agentThreadTasks: (threadId: string, query: { before?: string | null; since?: number | null } = {}) =>
    `/api/agents/threads/${encodeURIComponent(threadId)}/tasks${query.before ? `?before=${encodeURIComponent(query.before)}` : query.since != null ? `?since=${query.since}` : ""}`,
  agentTaskStop: (taskId: string) => `/api/agents/tasks/${encodeURIComponent(taskId)}/stop`,
  agentTask: (taskId: string) => `/api/agents/tasks/${encodeURIComponent(taskId)}`,
  agentPageVersion: (revision: number) => `/api/agent-page/versions/${revision}`,
  /** The folder a version's files are read from, ending in "/". */
  agentPageFilesBase: (revision: number) => `/api/agent-page/files/${revision}/`,
  agentPageData: (name: string) => `/api/agent-page/data/${encodeURIComponent(name)}`,
  agentPageSource: (name: string) => `/api/agent-page/sources/${encodeURIComponent(name)}`,
  agentPageUpdate: (name: string) => `/api/agent-page/updates/${encodeURIComponent(name)}`,
  scheduleRuns: (id: string) => `/api/schedules/${encodeURIComponent(id)}/runs`,
  schedulePause: (id: string) => `/api/schedules/${encodeURIComponent(id)}/pause`,
  file: (filePath: string, opts: { part?: "start" | "end"; line?: number } = {}) => {
    const query = new URLSearchParams({ path: filePath });
    if (opts.part) query.set("part", opts.part);
    if (opts.line !== undefined) query.set("line", String(opts.line));
    return `/api/files?${query.toString()}`;
  },
  fileRaw: (filePath: string) => `/api/files/raw?${new URLSearchParams({ path: filePath }).toString()}`,
  fileDownload: (filePath: string) => `/api/files/download?${new URLSearchParams({ path: filePath }).toString()}`,
  fileSave: "/api/files/save",
  shareFiles: "/api/share-files",
  scheduleResume: (id: string) => `/api/schedules/${encodeURIComponent(id)}/resume`,
  scheduleRun: (id: string) => `/api/schedules/${encodeURIComponent(id)}/run`,
  dutySidebar: (threadId: string) => `/api/agents/manager/threads/${encodeURIComponent(threadId)}/sidebar`,
  sideChats: () => "/api/agents/personal/side-chats",
  sideChat: (id: string) => `/api/agents/personal/side-chats/${encodeURIComponent(id)}`,
  sideChatSeen: (id: string) => `/api/agents/personal/side-chats/${encodeURIComponent(id)}/seen`,
  sideChatSummary: (id: string) => `/api/agents/personal/side-chats/${encodeURIComponent(id)}/summary`,
  sideChatSend: (id: string) => `/api/agents/personal/side-chats/${encodeURIComponent(id)}/send`,
  taskBoardTasks: (opts: { deleted?: boolean } = {}) => `/api/task-board/tasks${opts.deleted ? "?deleted=1" : ""}`,
  taskBoardTask: (id: string) => `/api/task-board/tasks/${encodeURIComponent(id)}`,
  taskBoardRestore: (id: string) => `/api/task-board/tasks/${encodeURIComponent(id)}/restore`,
  taskBoardForever: (id: string) => `/api/task-board/tasks/${encodeURIComponent(id)}/forever`,
  taskBoardComments: (id: string) => `/api/task-board/tasks/${encodeURIComponent(id)}/comments`,
  taskBoardOpened: (id: string) => `/api/task-board/tasks/${encodeURIComponent(id)}/opened`,
  taskBoardLabels: (id: string) => `/api/task-board/tasks/${encodeURIComponent(id)}/labels`,
  taskBoardLabel: (id: string, name: string) => `/api/task-board/tasks/${encodeURIComponent(id)}/labels/${encodeURIComponent(name)}`,
  taskBoardDone: () => "/api/task-board/done",
  stickyNotes: () => "/api/sticky-notes",
  stickyNoteDone: (id: string) => `/api/sticky-notes/${encodeURIComponent(id)}/done`,
  stickyNoteRestore: (id: string) => `/api/sticky-notes/${encodeURIComponent(id)}/restore`,
  stickyNotesSeen: () => "/api/sticky-notes/seen",
  calendar: (from: number, to: number) => `/api/calendar?from=${from}&to=${to}`,
  calendarPause: (id: string) => `/api/calendar/${encodeURIComponent(id)}/pause`,
  calendarResume: (id: string) => `/api/calendar/${encodeURIComponent(id)}/resume`,
  calendarSkip: (id: string) => `/api/calendar/${encodeURIComponent(id)}/skip`,
  calendarEntry: (id: string) => `/api/calendar/${encodeURIComponent(id)}`,
  canvasById: (id: string) => `/api/canvas/${encodeURIComponent(id)}`,
  canvasTitles: (ids: readonly string[]) => `/api/canvases/titles?ids=${encodeURIComponent(ids.join(","))}`,
  canvasMentions: (query: string, limit: number) => `/api/canvases/mentions?q=${encodeURIComponent(query)}&limit=${limit}`,
  canvasAssetsBase: (id: string) => `/api/canvas/${encodeURIComponent(id)}/assets/`,
  memoryDreamRun: (id: string) => `/api/memory/dream/runs/${encodeURIComponent(id)}`,
  memoryEntryHistory: (id: string) => `/api/memory/entries/${encodeURIComponent(id)}/history`,
  paneById: (paneId: string) => `/api/panes/${encodeURIComponent(paneId)}`,
  paneSplit: (paneId: string) => `/api/panes/${encodeURIComponent(paneId)}/split`,
  workerChanges: (workerId: string) =>
    `/api/workers/${encodeURIComponent(workerId)}/changes`,
  workerChangesFile: (workerId: string, filePath: string) =>
    `/api/workers/${encodeURIComponent(workerId)}/changes/file?path=${encodeURIComponent(filePath)}`,
  projectById: (id: string) => `/api/projects/${encodeURIComponent(id)}`,
  projectWorkers: (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/workers`,
  projectReconcile: (id: string) => `/api/projects/${encodeURIComponent(id)}/reconcile`,
  projectCanvases: (id: string, limit: number) => `/api/projects/${encodeURIComponent(id)}/canvases?limit=${limit}`,
  terminalWindow: (windowId: string) => `/api/terminals/windows/${encodeURIComponent(windowId)}`,
  workerById: (id: string) => `/api/workers/${encodeURIComponent(id)}`,
  workerPin: (id: string) => `/api/workers/${encodeURIComponent(id)}/pin`,
  terminalPin: (paneId: string) => `/api/terminals/pins/${encodeURIComponent(paneId)}`,
  workerArchiveCheck: (id: string) => `/api/workers/${encodeURIComponent(id)}/archive-check`,
  workerCanvases: (id: string) => `/api/workers/${encodeURIComponent(id)}/canvases`,
  workerPlan: (id: string) => `/api/workers/${encodeURIComponent(id)}/plan`,
  workerRecord: (id: string) => `/api/workers/${encodeURIComponent(id)}/record`,
  workerPanes: (id: string) => `/api/workers/${encodeURIComponent(id)}/panes`,
  settingsProviderModels: (providerName: string) =>
    `/api/settings/providers/${encodeURIComponent(providerName)}/models`,
  settingsProviderCheck: (providerName: string) =>
    `/api/settings/providers/${encodeURIComponent(providerName)}/check`,
  workItemAcknowledge: (id: string) => `/api/work-items/${encodeURIComponent(id)}/acknowledge`,
} as const;
