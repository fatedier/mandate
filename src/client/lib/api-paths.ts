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
  projectFeatures: (projectId: string) =>
    apiPath(API_PATHS.projectFeatures(projectId)),
  featureById: (id: string) => apiPath(API_PATHS.featureById(id)),
  featurePanes: (id: string) => apiPath(API_PATHS.featurePanes(id)),
  featureChanges: (featureId: string, compare?: "head" | "branch") =>
    apiPath(`${API_PATHS.featureChanges(featureId)}${compare ? `?compare=${compare}` : ""}`),
  featureChangesFile: (featureId: string, filePath: string, compare?: "head" | "branch") =>
    apiPath(
      `${API_PATHS.featureChangesFile(featureId, filePath)}${compare ? `&compare=${compare}` : ""}`
    ),
  tmuxSessions: apiPath(API_ROUTES.tmuxSessions),
  paneById: (paneId: string) => apiPath(API_PATHS.paneById(paneId)),
  paneSplit: (paneId: string) => apiPath(API_PATHS.paneSplit(paneId)),
  windowDetail: (sessionName: string, windowName: string) =>
    apiPath(API_PATHS.sessionWindow(sessionName, windowName)),
  projectAdopt: apiPath(API_ROUTES.projectAdopt),
  projectReconcile: (projectId: string) =>
    apiPath(API_PATHS.projectReconcile(projectId)),
  agentActiveWakes: apiPath(API_ROUTES.agentActiveWakes),
  agentPendingMonitors: apiPath(API_ROUTES.agentPendingMonitors),
  agentGlobal: apiPath(API_ROUTES.agentGlobal),
  agentGlobalHandoffs: (ids: readonly string[]) =>
    apiPath(`${API_ROUTES.agentGlobalHandoffs}?ids=${ids.map(encodeURIComponent).join(",")}`),
  agentGlobalSeen: apiPath(API_ROUTES.agentGlobalSeen),
  agentWakeCancel: (wakeId: string) => apiPath(API_PATHS.agentWakeCancel(wakeId)),
  agentThreadModel: (threadId: string) => apiPath(API_PATHS.agentThreadModel(threadId)),
  agentWakeRetry: (wakeId: string) => apiPath(API_PATHS.agentWakeRetry(wakeId)),
  canvasById: (id: string) => apiPath(API_PATHS.canvasById(id)),
  canvasTitles: (ids: readonly string[]) => apiPath(API_PATHS.canvasTitles(ids)),
  canvasAssetsBase: (id: string) => apiPath(API_PATHS.canvasAssetsBase(id)),
  agentPage: apiPath(API_ROUTES.agentPage),
  agentPageVersion: (revision: number) => apiPath(API_PATHS.agentPageVersion(revision)),
  agentPageData: (name: string) => apiPath(API_PATHS.agentPageData(name)),
  agentPageAnswers: apiPath(API_ROUTES.agentPageAnswers),
  agentPageSources: apiPath(API_ROUTES.agentPageSources),
  agentPageSource: (name: string) => apiPath(API_PATHS.agentPageSource(name)),
  featureCanvases: (id: string) => apiPath(API_PATHS.featureCanvases(id)),
  threadCanvases: (threadId: string) => apiPath(API_PATHS.agentManagerThreadCanvases(threadId)),
  featurePlan: (id: string) => apiPath(API_PATHS.featurePlan(id)),
  /** The whole plan, earlier work included; the plain path is the page's. */
  featurePlanWhole: (id: string) => apiPath(`${API_PATHS.featurePlan(id)}?history=1`),
  featureRecord: (id: string) => apiPath(API_PATHS.featureRecord(id)),
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
  /** The voice socket: every session is the global agent's. `activation`
   *  names the turn-on, so a reconnect continues it. */
  voiceWs: (activation?: string | null) =>
    apiWebSocketPath(API_ROUTES.voiceWs) + (activation ? `?activation=${encodeURIComponent(activation)}` : ""),
  workItems: (opts: { featureId?: string; before?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    // featureId is a direct 1:1 lookup, so it stands alone — mixing it with
    // the list filters would imply a paging story the binding does not have.
    if (opts.featureId) return apiPath(`${API_ROUTES.workItems}?featureId=${encodeURIComponent(opts.featureId)}`);
    if (opts.before) params.set("before", opts.before);
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return apiPath(qs ? `${API_ROUTES.workItems}?${qs}` : API_ROUTES.workItems);
  },
  workItemAcknowledge: (id: string) => apiPath(API_PATHS.workItemAcknowledge(id)),
  featurePin: (id: string) => apiPath(API_PATHS.featurePin(id)),
  featureArchiveCheck: (id: string) => apiPath(API_PATHS.featureArchiveCheck(id)),
  storageStatus: apiPath(API_ROUTES.storageStatus),
  storageCleanup: apiPath(API_ROUTES.storageCleanup)
} as const;
