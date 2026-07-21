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
  return query.toString();
}

export const api = {
  events: apiPath(API_ROUTES.events),
  state: apiPath(API_ROUTES.state),
  info: apiPath(API_ROUTES.info),
  settingsConfig: apiPath(API_ROUTES.settingsConfig),
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
  windowInspect: apiPath(API_ROUTES.windowInspect),
  projects: apiPath(API_ROUTES.projects),
  projectReorder: apiPath(API_ROUTES.projectReorder),
  projectById: (id: string) => apiPath(API_PATHS.projectById(id)),
  projectFeatures: (projectId: string) =>
    apiPath(API_PATHS.projectFeatures(projectId)),
  featureById: (id: string) => apiPath(API_PATHS.featureById(id)),
  featurePanes: (id: string) => apiPath(API_PATHS.featurePanes(id)),
  projectBranches: (projectId: string) =>
    apiPath(API_PATHS.projectBranches(projectId)),
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
  agentWakeCancel: (wakeId: string) => apiPath(API_PATHS.agentWakeCancel(wakeId)),
  canvasById: (id: string) => apiPath(API_PATHS.canvasById(id)),
  canvasAssetsBase: (id: string) => apiPath(API_PATHS.canvasAssetsBase(id)),
  canvasEvents: (id: string) => apiPath(API_PATHS.canvasEvents(id)),
  featureCanvases: (id: string) => apiPath(API_PATHS.featureCanvases(id)),
  activityCalls: (params: LlmCallQuery) => apiPath(`${API_ROUTES.activityCalls}?${llmCallQuery(params)}`),
  activityCall: (id: string) => apiPath(API_PATHS.activityCall(id)),
  // `group` is one of a closed set rather than free text, which is what makes
  // interpolating it straight into the query safe: every member is url-safe,
  // and widening the parameter is the change that would stop being true.
  activitySummary: (days: number, group?: ActivityGroupKey) =>
    apiPath(`${API_ROUTES.activitySummary}?days=${days}${group ? `&group=${group}` : ""}`),
  memoryDreamRuns: apiPath(API_ROUTES.memoryDreamRuns),
  memoryDreamRun: (id: string) => apiPath(API_PATHS.memoryDreamRun(id)),
  memoryEntries: (params: URLSearchParams | string = "") => {
    const qs = params instanceof URLSearchParams ? params.toString() : params;
    return apiPath(qs ? `${API_ROUTES.memoryEntries}?${qs}` : API_ROUTES.memoryEntries);
  },
  memoryStats: apiPath(API_ROUTES.memoryStats),
  skills: apiPath(API_ROUTES.skills),
  skillsRefresh: apiPath(API_ROUTES.skillsRefresh),
  uiLocation: apiPath(API_ROUTES.uiLocation),
  uiPageSummary: apiPath(API_ROUTES.uiPageSummary),
  voiceWs: () => apiWebSocketPath(API_ROUTES.voiceWs),
  workItems: (opts: { needsUser?: string | null; featureId?: string; before?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    // featureId is a direct 1:1 lookup, so it stands alone — mixing it with
    // the list filters would imply a paging story the binding does not have.
    if (opts.featureId) return apiPath(`${API_ROUTES.workItems}?featureId=${encodeURIComponent(opts.featureId)}`);
    if (opts.needsUser !== undefined && opts.needsUser !== null) params.set("needsUser", opts.needsUser);
    else if (opts.needsUser === null) params.set("needsUser", "none");
    if (opts.before) params.set("before", opts.before);
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return apiPath(qs ? `${API_ROUTES.workItems}?${qs}` : API_ROUTES.workItems);
  },
  workItem: (id: string) => apiPath(API_PATHS.workItem(id)),
  featurePin: (id: string) => apiPath(API_PATHS.featurePin(id)),
  storageStatus: apiPath(API_ROUTES.storageStatus),
  storageCleanup: apiPath(API_ROUTES.storageCleanup)
} as const;
