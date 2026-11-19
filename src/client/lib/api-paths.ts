import { API_PATHS, API_ROUTES } from "../../shared/api-contracts";
import type { ActivityGroupKey, LlmCallQuery } from "../../shared/api-contracts";
import { apiPath, apiWebSocketPath } from "./api-base";

function llmCallQuery(params: LlmCallQuery): string {
  const query = new URLSearchParams();
  if (params.limit != null) query.set("limit", String(params.limit));
  if (params.before) query.set("before", params.before);
  if (params.beforeId) query.set("beforeId", params.beforeId);
  if (params.status) query.set("status", params.status);
  if (params.purpose) query.set("purpose", params.purpose);
  if (params.provider) query.set("provider", params.provider);
  if (params.model) query.set("model", params.model);
  if (params.scopeType) query.set("scopeType", params.scopeType);
  if (params.day) query.set("day", params.day);
  if (params.fallback) query.set("fallback", params.fallback);
  if (params.q) query.set("q", params.q);
  if (params.agent) query.set("agent", params.agent);
  if (params.view) query.set("view", params.view);
  if (params.days != null) query.set("days", String(params.days));
  if (params.tz) query.set("tz", params.tz);
  return query.toString();
}

export const api = {
  events: apiPath(API_ROUTES.events),
  info: apiPath(API_ROUTES.info),
  settingsConfig: apiPath(API_ROUTES.settingsConfig),
  settingsWebSearchCheck: apiPath(API_ROUTES.settingsWebSearchCheck),
  notificationsTest: apiPath(API_ROUTES.notificationsTest),
  notificationsTelegramConnect: apiPath(API_ROUTES.notificationsTelegramConnect),
  setupStatus: apiPath(API_ROUTES.setupStatus),
  codexAuthStart: apiPath(API_ROUTES.codexAuthStart),
  codexAuthStatus: (requestId: string) =>
    apiPath(`${API_ROUTES.codexAuthStatus}?requestId=${encodeURIComponent(requestId)}`),
  codexAuthLogout: apiPath(API_ROUTES.codexAuthLogout),
  settingsProviderModels: (providerName: string, opts: { refresh?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (opts.refresh) params.set("refresh", "1");
    const qs = params.toString();
    const path = API_PATHS.settingsProviderModels(providerName);
    return apiPath(qs ? `${path}?${qs}` : path);
  },
  settingsProviderCheck: (providerName: string) => apiPath(API_PATHS.settingsProviderCheck(providerName)),
  windowInspect: apiPath(API_ROUTES.windowInspect),
  projects: apiPath(API_ROUTES.projects),
  projectReorder: apiPath(API_ROUTES.projectReorder),
  projectById: (id: string) => apiPath(API_PATHS.projectById(id)),
  projectCanvases: (id: string, limit: number) => apiPath(API_PATHS.projectCanvases(id, limit)),
  workerById: (id: string) => apiPath(API_PATHS.workerById(id)),
  workerPanes: (id: string) => apiPath(API_PATHS.workerPanes(id)),
  workerChanges: (workerId: string, compare: "head" | "branch") =>
    apiPath(`${API_PATHS.workerChanges(workerId)}?compare=${compare}`),
  workerChangesFile: (workerId: string, filePath: string, compare: "head" | "branch") =>
    apiPath(`${API_PATHS.workerChangesFile(workerId, filePath)}&compare=${compare}`),
  tmuxSessions: apiPath(API_ROUTES.tmuxSessions),
  terminals: apiPath(API_ROUTES.terminals),
  terminalPins: apiPath(API_ROUTES.terminalPins),
  terminalPinsOrder: apiPath(API_ROUTES.terminalPinsOrder),
  terminalPin: (paneId: string) => apiPath(API_PATHS.terminalPin(paneId)),
  paneById: (paneId: string) => apiPath(API_PATHS.paneById(paneId)),
  paneSplit: (paneId: string) => apiPath(API_PATHS.paneSplit(paneId)),
  terminalWindow: (windowId: string) => apiPath(API_PATHS.terminalWindow(windowId)),
  projectReconcile: (projectId: string) =>
    apiPath(API_PATHS.projectReconcile(projectId)),
  agentActiveWakes: apiPath(API_ROUTES.agentActiveWakes),
  agentPendingMonitors: apiPath(API_ROUTES.agentPendingMonitors),
  agentPersonal: apiPath(API_ROUTES.agentPersonal),
  agentPersonalHandoffs: (ids: readonly string[]) =>
    apiPath(`${API_ROUTES.agentPersonalHandoffs}?ids=${ids.map(encodeURIComponent).join(",")}`),
  agentPersonalSeen: apiPath(API_ROUTES.agentPersonalSeen),
  personalThreadTabs: apiPath(API_ROUTES.agentPersonalThreadTabs),
  personalThreadTab: (threadId: string) => apiPath(API_PATHS.agentPersonalThreadTab(threadId)),
  agentWakeCancel: (wakeId: string) => apiPath(API_PATHS.agentWakeCancel(wakeId)),
  agentThreadModel: (threadId: string) => apiPath(API_PATHS.agentThreadModel(threadId)),
  agentWakeRetry: (wakeId: string) => apiPath(API_PATHS.agentWakeRetry(wakeId)),
  canvasById: (id: string) => apiPath(API_PATHS.canvasById(id)),
  canvasTitles: (ids: readonly string[]) => apiPath(API_PATHS.canvasTitles(ids)),
  canvasMentions: (query: string, limit: number) => apiPath(API_PATHS.canvasMentions(query, limit)),
  canvasAssetsBase: (id: string) => apiPath(API_PATHS.canvasAssetsBase(id)),
  agentPage: apiPath(API_ROUTES.agentPage),
  agentPageVersion: (revision: number) => apiPath(API_PATHS.agentPageVersion(revision)),
  agentPageFilesBase: (revision: number) => apiPath(API_PATHS.agentPageFilesBase(revision)),
  agentPageData: (name: string) => apiPath(API_PATHS.agentPageData(name)),
  agentPageAnswers: apiPath(API_ROUTES.agentPageAnswers),
  agentPageSources: apiPath(API_ROUTES.agentPageSources),
  agentPageSource: (name: string) => apiPath(API_PATHS.agentPageSource(name)),
  agentPageUpdates: apiPath(API_ROUTES.agentPageUpdates),
  agentPageUpdate: (name: string) => apiPath(API_PATHS.agentPageUpdate(name)),
  workerCanvases: (id: string) => apiPath(API_PATHS.workerCanvases(id)),
  threadCanvases: (threadId: string) => apiPath(API_PATHS.agentManagerThreadCanvases(threadId)),
  threadReplyTabs: (threadId: string) => apiPath(API_PATHS.agentThreadReplyTabs(threadId)),
  threadReplyTab: (threadId: string, tabId: string) => apiPath(API_PATHS.agentThreadReplyTab(threadId, tabId)),
  workerPlan: (id: string) => apiPath(API_PATHS.workerPlan(id)),
  /** The whole plan, earlier work included; the plain path is the page's. */
  workerPlanWhole: (id: string) => apiPath(`${API_PATHS.workerPlan(id)}?history=1`),
  workerRecord: (id: string) => apiPath(API_PATHS.workerRecord(id)),
  activityCalls: (params: LlmCallQuery) => apiPath(`${API_ROUTES.activityCalls}?${llmCallQuery(params)}`),
  activityCall: (id: string) => apiPath(API_PATHS.activityCall(id)),
  pricingProvider: (name: string) => apiPath(API_PATHS.pricingProvider(name)),
  pricingMatch: (provider: string, model: string) => apiPath(`${API_ROUTES.pricingMatch}?${new URLSearchParams({ provider, model }).toString()}`),
  pricingCatalog: (q: string) => apiPath(`${API_ROUTES.pricingCatalog}?${new URLSearchParams({ q }).toString()}`),
  pricingStatus: apiPath(API_ROUTES.pricingStatus),
  // `group` is one of a closed set rather than free text, which is what makes
  // interpolating it straight into the query safe: every member is url-safe,
  // and widening the parameter is the change that would stop being true.
  activitySummary: (days: number, group?: ActivityGroupKey, options: { tz?: string | null; day?: string | null } = {}) => {
    const query = new URLSearchParams({ days: String(days) });
    if (group) query.set("group", group);
    if (options.day) query.set("day", options.day);
    if (options.tz) query.set("tz", options.tz);
    return apiPath(`${API_ROUTES.activitySummary}?${query}`);
  },
  activityFilterOptions: apiPath(API_ROUTES.activityFilterOptions),
  memoryBriefs: apiPath(API_ROUTES.memoryBriefs),
  memoryDreamRuns: apiPath(API_ROUTES.memoryDreamRuns),
  memoryDreamRun: (id: string) => apiPath(API_PATHS.memoryDreamRun(id)),
  memoryEntries: (params: URLSearchParams | string = "") => {
    const qs = params instanceof URLSearchParams ? params.toString() : params;
    return apiPath(qs ? `${API_ROUTES.memoryEntries}?${qs}` : API_ROUTES.memoryEntries);
  },
  memoryEntryHistory: (id: string) => apiPath(API_PATHS.memoryEntryHistory(id)),
  memoryStats: apiPath(API_ROUTES.memoryStats),
  skills: apiPath(API_ROUTES.skills),
  skillsRefresh: apiPath(API_ROUTES.skillsRefresh),
  learnedSkills: (params: URLSearchParams) => {
    const qs = params.toString();
    return apiPath(qs ? `${API_ROUTES.learnedSkills}?${qs}` : API_ROUTES.learnedSkills);
  },
  learnedSkill: (id: string) => apiPath(API_ROUTES.learnedSkill.replace(":id", encodeURIComponent(id))),
  learnedSkillRevision: (id: string, revision: number) =>
    apiPath(API_ROUTES.learnedSkillRevision.replace(":id", encodeURIComponent(id)).replace(":revision", String(revision))),
  skillReviews: apiPath(API_ROUTES.skillReviews),
  /** The voice socket: every session is the personal agent's. `activation`
   *  names the turn-on, so a reconnect continues it. */
  voiceWs: (activation?: string | null) =>
    apiWebSocketPath(API_ROUTES.voiceWs) + (activation ? `?activation=${encodeURIComponent(activation)}` : ""),
  workItems: (opts: { workerId?: string; limit?: number } = {}) => {
    // workerId is a direct 1:1 lookup, so it stands alone: a list limit
    // means nothing beside it.
    if (opts.workerId) return apiPath(`${API_ROUTES.workItems}?workerId=${encodeURIComponent(opts.workerId)}`);
    return apiPath(opts.limit ? `${API_ROUTES.workItems}?limit=${opts.limit}` : API_ROUTES.workItems);
  },
  workItemAcknowledge: (id: string) => apiPath(API_PATHS.workItemAcknowledge(id)),
  workerPin: (id: string) => apiPath(API_PATHS.workerPin(id)),
  workerArchiveCheck: (id: string) => apiPath(API_PATHS.workerArchiveCheck(id)),
  storageStatus: apiPath(API_ROUTES.storageStatus),
  storageCleanup: apiPath(API_ROUTES.storageCleanup),
  taskBoardTasks: (opts: { deleted?: boolean } = {}) => apiPath(API_PATHS.taskBoardTasks(opts)),
  taskBoardTask: (id: string) => apiPath(API_PATHS.taskBoardTask(id)),
  taskBoardRestore: (id: string) => apiPath(API_PATHS.taskBoardRestore(id)),
  taskBoardForever: (id: string) => apiPath(API_PATHS.taskBoardForever(id)),
  taskBoardComments: (id: string) => apiPath(API_PATHS.taskBoardComments(id)),
  taskBoardOpened: (id: string) => apiPath(API_PATHS.taskBoardOpened(id)),
  taskBoardLabels: (id: string) => apiPath(API_PATHS.taskBoardLabels(id)),
  taskBoardLabel: (id: string, name: string) => apiPath(API_PATHS.taskBoardLabel(id, name)),
  taskBoardDone: apiPath(API_PATHS.taskBoardDone()),
  stickyNotes: apiPath(API_PATHS.stickyNotes()),
  stickyNoteDone: (id: string) => apiPath(API_PATHS.stickyNoteDone(id)),
  stickyNoteRestore: (id: string) => apiPath(API_PATHS.stickyNoteRestore(id)),
  stickyNotesSeen: apiPath(API_PATHS.stickyNotesSeen()),
  calendar: (from: number, to: number) => apiPath(API_PATHS.calendar(from, to)),
  calendarPause: (id: string) => apiPath(API_PATHS.calendarPause(id)),
  calendarResume: (id: string) => apiPath(API_PATHS.calendarResume(id)),
  calendarSkip: (id: string) => apiPath(API_PATHS.calendarSkip(id)),
  calendarEntry: (id: string) => apiPath(API_PATHS.calendarEntry(id))
} as const;
