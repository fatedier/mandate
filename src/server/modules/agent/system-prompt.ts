import { clearPromptTemplateCache, renderPromptFile } from "../../platform/prompts/prompt-template.js";
import workerTemplatePath from "./prompts/worker.md" with { type: "file" };
import workerInitialContextTemplatePath from "./prompts/worker-initial-context.md" with { type: "file" };
import workerRuntimeContextTemplatePath from "./prompts/worker-runtime-context.md" with { type: "file" };
import managerTemplatePath from "./prompts/manager.md" with { type: "file" };
import managerInitialContextTemplatePath from "./prompts/manager-initial-context.md" with { type: "file" };
import managerRuntimeContextTemplatePath from "./prompts/manager-runtime-context.md" with { type: "file" };

const WORKER_TEMPLATE_PATH = workerTemplatePath;
const WORKER_INITIAL_CONTEXT_TEMPLATE_PATH = workerInitialContextTemplatePath;
const WORKER_RUNTIME_CONTEXT_TEMPLATE_PATH = workerRuntimeContextTemplatePath;
const MANAGER_TEMPLATE_PATH = managerTemplatePath;
const MANAGER_INITIAL_CONTEXT_TEMPLATE_PATH = managerInitialContextTemplatePath;
const MANAGER_RUNTIME_CONTEXT_TEMPLATE_PATH = managerRuntimeContextTemplatePath;
const FEATURE_PANE_DIGEST_LIMIT = 4;
const FEATURE_PANE_SUMMARY_MAX_CHARS = 180;
const MANAGER_PROJECT_INDEX_LIMIT = 8;
const MANAGER_FEATURE_LIMIT = 12;
const FEATURE_DIGEST_SUMMARY_MAX_CHARS = 180;

interface ProjectCtx {
  id: string;
  name: string;
  workingDir: string;
  isGit: boolean;
  gitRemote: string | null;
  tmuxSessionName: string;
}

interface FeatureCtx {
  id: string;
  name: string;
  tmuxWindowName: string;
  mode: string;
  branch: string | null;
  baseRef: string | null;
  worktreePath: string | null;
}

export interface PaneCtx {
  paneId: string;
  name?: string;
  description?: string;
  command: string;
  cwd: string;
  status: string;
  summary: string;
}

export interface PromptInput {
  project: ProjectCtx;
  feature: FeatureCtx;
  panes: PaneCtx[];
  agentPreferences?: string;
  /** Rendered structured task queue section, or empty string. */
  tasksSection?: string;
  /** Rendered memory database section, or empty string. */
  memorySection?: string;
  /** Rendered <available-skills> block, or empty string. Caller computes
   *  it from the SkillRegistry and injects it into initial context. */
  availableSkillsSection?: string;
}

export type WorkerInitialContextInput = Pick<
  PromptInput,
  "project" | "feature" | "agentPreferences" | "availableSkillsSection"
>;

export type WorkerRuntimeContextInput = Pick<
  PromptInput,
  "panes" | "tasksSection" | "memorySection"
>;

function renderPanes(panes: PaneCtx[]): string {
  if (panes.length === 0) {
    return [
      "- Active panes: 0",
      "- Exact state: use list_panes before relying on pane state."
    ].join("\n");
  }
  const visible = panes.slice(0, FEATURE_PANE_DIGEST_LIMIT);
  const lines = [
    `- Active panes: ${panes.length}${statusSummary(panes.map((pane) => pane.status))}`,
    "- Exact state: use list_panes for the full pane list; use pane_status/read_pane before relying on pane output.",
    "- Pane index (limited):"
  ];
  for (const pane of visible) {
    const label = pane.name ? `${pane.name} (${pane.paneId})` : pane.paneId;
    const summary = pane.summary
      ? ` - ${limitPromptText(pane.summary, FEATURE_PANE_SUMMARY_MAX_CHARS)}`
      : "";
    lines.push(`  - ${label} [${pane.status}]${summary}`);
  }
  const omitted = panes.length - visible.length;
  if (omitted > 0) {
    lines.push(`  - ${omitted} additional pane(s) omitted from this compact digest.`);
  }
  return lines.join("\n");
}

function renderGit(p: ProjectCtx): string {
  if (!p.isGit) return "not a git repo";
  return p.gitRemote ? `git (remote: ${p.gitRemote})` : "git (no remote)";
}

function renderAgentPreferences(preferences: string | undefined): string {
  const text = preferences?.trim();
  if (!text) return "";
  return [
    "## Agent preferences",
    "",
    text,
    "",
    "Treat these as user preferences, not hard rules. Follow them when practical, and briefly explain if you choose a different path."
  ].join("\n");
}

export function buildWorkerSystemPrompt(): string {
  return renderPromptFile(WORKER_TEMPLATE_PATH, {});
}

export function buildWorkerInitialContext(input: WorkerInitialContextInput): string {
  const tokens: Record<string, string> = {
    projectName: input.project.name,
    projectWorkingDir: input.project.workingDir,
    projectTmuxSessionName: input.project.tmuxSessionName,
    projectGitDescription: renderGit(input.project),
    featureName: input.feature.name,
    featureId: input.feature.id,
    featureTmuxWindowName: input.feature.tmuxWindowName,
    featureMode: input.feature.mode,
    featureBranch: input.feature.branch ?? "(none)",
    featureBaseRef: input.feature.baseRef ?? "(none)",
    featureWorktreePath: input.feature.worktreePath ?? "(none)",
    agentPreferencesSection: renderAgentPreferences(input.agentPreferences),
    availableSkillsSection: renderAvailableSkillsSection(input.availableSkillsSection)
  };
  return renderPromptFile(WORKER_INITIAL_CONTEXT_TEMPLATE_PATH, tokens);
}

export function buildWorkerRuntimeContext(input: WorkerRuntimeContextInput): string {
  const tokens: Record<string, string> = {
    panesSection: renderPanes(input.panes),
    tasksSection: input.tasksSection ?? "",
    memorySection: input.memorySection ?? ""
  };
  return renderPromptFile(WORKER_RUNTIME_CONTEXT_TEMPLATE_PATH, tokens);
}

// Test seam — clear cached template if needed.
export function _clearTemplateCache() {
  clearPromptTemplateCache();
}

interface ManagerProjectCtx {
  id: string;
  name: string;
  workingDir: string;
  isGit: boolean;
  gitRemote: string | null;
  featureCount: number;
}

interface ManagerFeatureCtx {
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  mode: string;
  branch: string | null;
  baseRef: string | null;
  workingDir: string | null;
  primaryPaneStatus: string;
  updatedAt?: string;
  digest?: {
    summary: string;
    decisions: string[];
    openQuestions: string[];
    constraints: string[];
    updatedAt: string;
  } | null;
}

export interface ManagerPromptInput {
  projects: ManagerProjectCtx[];
  features: ManagerFeatureCtx[];
  memorySection?: string;
}

export interface ManagerInitialContextInput {
  managerDir: string;
  agentPreferences?: string;
  availableSkillsSection?: string;
}

function renderProjects(projects: ManagerProjectCtx[]): string {
  if (projects.length === 0) {
    return [
      "- Active projects: 0",
      "- No active projects."
    ].join("\n");
  }
  const visible = projects.slice(0, MANAGER_PROJECT_INDEX_LIMIT);
  const lines = [
    `- Active projects: ${projects.length}`,
    "- Exact project roots and git metadata: call list_projects before reading or writing project files.",
    "- Project index (limited):"
  ];
  for (const project of visible) {
    lines.push(`  - ${project.name} (id ${project.id}) - ${project.featureCount} feature(s)`);
  }
  const omitted = projects.length - visible.length;
  if (omitted > 0) {
    lines.push(`  - ${omitted} additional project(s) omitted from this compact digest.`);
  }
  return lines.join("\n");
}

function renderFeatures(features: ManagerFeatureCtx[]): string {
  if (features.length === 0) {
    return [
      "- Active features: 0",
      "- No active features."
    ].join("\n");
  }
  const visible = selectManagerFeatures(features);
  const lines = [
    `- Active features: ${features.length}`,
    "- Exact feature state: call list_features/get_feature_status; use read_feature_thread for deeper recent history.",
    "- Feature index (limited):"
  ];
  for (const feature of visible) {
    const branch = feature.branch ?? "(no branch)";
    const baseRef = feature.baseRef ? `, base ${feature.baseRef}` : "";
    const digest = renderFeatureDigest(feature.digest);
    lines.push(`  - ${feature.name} (id ${feature.id}) in ${feature.projectName} - mode ${feature.mode}, branch ${branch}${baseRef}, status ${feature.primaryPaneStatus}${digest}`);
  }
  const omitted = features.length - visible.length;
  if (omitted > 0) {
    lines.push(`  - ${omitted} additional feature(s) omitted from this compact digest.`);
  }
  return lines.join("\n");
}

function renderManagerSummary(input: ManagerPromptInput): string {
  const shownFeatureCount = selectManagerFeatures(input.features).length;
  return [
    `- Active projects: ${input.projects.length}`,
    `- Active features: ${input.features.length}`,
    input.features.length > shownFeatureCount
      ? `- Feature index shown below: ${shownFeatureCount} of ${input.features.length}, prioritized by feature context freshness and recency.`
      : `- Feature index shown below: ${shownFeatureCount}`,
    "- Runtime context is a compact routing digest. Use tools for authoritative current state."
  ].join("\n");
}

function selectManagerFeatures(features: ManagerFeatureCtx[]): ManagerFeatureCtx[] {
  if (features.length <= MANAGER_FEATURE_LIMIT) return features;
  return [...features]
    .sort((a, b) => managerFeaturePriority(b) - managerFeaturePriority(a)
      || compareNullableStrings(a.projectName, b.projectName)
      || compareNullableStrings(a.name, b.name)
      || compareNullableStrings(a.id, b.id))
    .slice(0, MANAGER_FEATURE_LIMIT);
}

function managerFeaturePriority(feature: ManagerFeatureCtx): number {
  return timestampScore(feature.digest?.updatedAt ?? feature.updatedAt);
}

function timestampScore(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareNullableStrings(a: string | undefined, b: string | undefined): number {
  return (a ?? "").localeCompare(b ?? "");
}

function renderFeatureDigest(digest: ManagerFeatureCtx["digest"]): string {
  if (!digest) return "";
  return `; context: ${limitPromptText(digest.summary, FEATURE_DIGEST_SUMMARY_MAX_CHARS)}`;
}

function limitPromptText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function statusSummary(statuses: string[]): string {
  if (statuses.length === 0) return "";
  const counts = new Map<string, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  const rendered = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => `${status} ${count}`)
    .join(", ");
  return rendered ? ` (${rendered})` : "";
}

export function buildManagerSystemPrompt(): string {
  return renderPromptFile(MANAGER_TEMPLATE_PATH, {});
}

export function buildManagerInitialContext(input: ManagerInitialContextInput): string {
  return renderPromptFile(MANAGER_INITIAL_CONTEXT_TEMPLATE_PATH, {
    managerDir: input.managerDir,
    agentPreferencesSection: renderAgentPreferences(input.agentPreferences),
    availableSkillsSection: renderAvailableSkillsSection(input.availableSkillsSection)
  });
}

export function buildManagerRuntimeContext(input: ManagerPromptInput): string {
  const tokens: Record<string, string> = {
    summarySection: renderManagerSummary(input),
    projectsSection: renderProjects(input.projects),
    featuresSection: renderFeatures(input.features),
    memorySection: input.memorySection ?? ""
  };
  return renderPromptFile(MANAGER_RUNTIME_CONTEXT_TEMPLATE_PATH, tokens);
}

function renderAvailableSkillsSection(availableSkillsSection?: string): string {
  const skills = availableSkillsSection?.trim();
  if (!skills) return "";
  return [
    "## Available skills",
    "",
    skills
  ].join("\n");
}
