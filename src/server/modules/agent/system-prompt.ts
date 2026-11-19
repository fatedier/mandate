import { renderPromptFile } from "../../platform/prompts/prompt-template.js";
import workerTemplatePath from "./prompts/worker.md" with { type: "file" };
import workerInitialContextTemplatePath from "./prompts/worker-initial-context.md" with { type: "file" };
import workerRuntimeContextTemplatePath from "./prompts/worker-runtime-context.md" with { type: "file" };
import managerTemplatePath from "./prompts/manager.md" with { type: "file" };
import managerInitialContextTemplatePath from "./prompts/manager-initial-context.md" with { type: "file" };
import managerRuntimeContextTemplatePath from "./prompts/manager-runtime-context.md" with { type: "file" };
import messageTimesTemplatePath from "./prompts/message-times.md" with { type: "file" };
import type { Config } from "../../config.js";
import { toolReviewAvailable } from "../../config/model-resolution.js";
import type { WorkerPlanDto } from "../../../shared/api/plans.js";
import { WORKER_STATE_LABEL, workerStateFor, planProgress, type FailureKind } from "../../../shared/worker-state.js";
import { oneLine } from "../../../shared/plan-text.js";

const WORKER_TEMPLATE_PATH = workerTemplatePath;
const WORKER_INITIAL_CONTEXT_TEMPLATE_PATH = workerInitialContextTemplatePath;
const WORKER_RUNTIME_CONTEXT_TEMPLATE_PATH = workerRuntimeContextTemplatePath;
const MANAGER_TEMPLATE_PATH = managerTemplatePath;
const MANAGER_INITIAL_CONTEXT_TEMPLATE_PATH = managerInitialContextTemplatePath;
const MANAGER_RUNTIME_CONTEXT_TEMPLATE_PATH = managerRuntimeContextTemplatePath;
const WORKER_PANE_DIGEST_LIMIT = 4;
const WORKER_PANE_SUMMARY_MAX_CHARS = 180;
const MANAGER_PROJECT_INDEX_LIMIT = 8;
const MANAGER_WORKER_LIMIT = 12;
const WORKER_PLAN_LINE_MAX_CHARS = 180;

interface ProjectCtx {
  id: string;
  name: string;
  workingDir: string;
  isGit: boolean;
  gitRemote: string | null;
  tmuxSessionName: string;
}

interface WorkerCtx {
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
  status: string;
  summary: string;
}

interface PromptInput {
  project: ProjectCtx;
  worker: WorkerCtx;
  /** Null when tmux did not answer: not known, rather than none. */
  panes: PaneCtx[] | null;
  agentPreferences?: string;
  /** The user's rules for the tool-call review while it is on
   *  (activeToolReviewRules), or empty. */
  toolReviewRules?: string;
  /** Rendered <available-skills> block, or empty string. Caller computes
   *  it from the SkillRegistry and injects it into initial context. */
  availableSkillsSection?: string;
}

type WorkerInitialContextInput = Pick<
  PromptInput,
  "project" | "worker" | "agentPreferences" | "toolReviewRules" | "availableSkillsSection"
> & {
  /** The worker's plan as text (renderPlanText). The initial context is
   *  re-appended after each compaction, so this is how the plan survives it. */
  planSection?: string;
  /** buildMemorySection's output: memory opens the window. */
  memorySection?: string;
};

type WorkerRuntimeContextInput = Pick<
  PromptInput,
  "panes"
>;

function renderPanes(panes: PaneCtx[] | null): string {
  if (panes === null) {
    return [
      "- Active panes: unknown (tmux did not answer)",
      "- Exact state: use list_panes before relying on pane state."
    ].join("\n");
  }
  if (panes.length === 0) {
    return [
      "- Active panes: 0",
      "- Exact state: use list_panes before relying on pane state."
    ].join("\n");
  }
  const visible = panes.slice(0, WORKER_PANE_DIGEST_LIMIT);
  const lines = [
    `- Active panes: ${panes.length}${statusSummary(panes.map((pane) => pane.status))}`,
    "- Exact state: use list_panes for the full pane list; use pane_status/read_pane before relying on pane output.",
    "- Pane index (limited):"
  ];
  for (const pane of visible) {
    const label = pane.name ? `${pane.name} (${pane.paneId})` : pane.paneId;
    const summary = pane.summary
      ? ` - ${limitPromptText(pane.summary, WORKER_PANE_SUMMARY_MAX_CHARS)}`
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

/** The user's rules for the tool-call review, while the review is on (and
 *  can run: it has a second look); empty otherwise, and when they wrote none. */
export function activeToolReviewRules(config: Config): string {
  if (!config.agent.toolReviewEnabled || !toolReviewAvailable(config)) return "";
  return config.agent.toolReviewRules.trim();
}

/** What every agent reads of the user's rules while the review is on. The
 *  review counts them as the user's words. */
export function renderToolReviewRules(rules: string | undefined): string {
  const text = rules?.trim();
  if (!text) return "";
  return [
    "## Your user's rules for risky steps",
    "",
    text,
    "",
    "What these rules allow you may do without asking; what they say needs the user's word needs it. A reviewer checks risky steps against them."
  ].join("\n");
}

/** The preferences, then the review's rules: one place in the context. */
function renderUserGuidance(preferences: string | undefined, rules: string | undefined): string {
  return [renderAgentPreferences(preferences), renderToolReviewRules(rules)].filter(Boolean).join("\n\n");
}

/** Every agent's system prompt ends with how its messages carry times:
 *  a scope's prompt, then this paragraph. Empty prompt: none to end. */
export function withMessageTimes(prompt: string, timeZone: string): string {
  if (!prompt.trim()) return prompt;
  return `${prompt.trimEnd()}\n\n${renderPromptFile(messageTimesTemplatePath, { timeZone }).trim()}`;
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
    workerName: input.worker.name,
    workerId: input.worker.id,
    workerTmuxWindowName: input.worker.tmuxWindowName,
    workerMode: input.worker.mode,
    workerBranch: input.worker.branch ?? "(none)",
    workerBaseRef: input.worker.baseRef ?? "(none)",
    workerWorktreePath: input.worker.worktreePath ?? "(none)",
    agentPreferencesSection: renderUserGuidance(input.agentPreferences, input.toolReviewRules),
    availableSkillsSection: renderAvailableSkillsSection(input.availableSkillsSection),
    planSection: input.planSection ?? "No plan yet.",
    memorySection: input.memorySection ?? ""
  };
  return renderPromptFile(WORKER_INITIAL_CONTEXT_TEMPLATE_PATH, tokens);
}

export function buildWorkerRuntimeContext(input: WorkerRuntimeContextInput): string {
  const tokens: Record<string, string> = {
    panesSection: renderPanes(input.panes)
  };
  return renderPromptFile(WORKER_RUNTIME_CONTEXT_TEMPLATE_PATH, tokens);
}

interface ManagerProjectCtx {
  id: string;
  name: string;
  workerCount: number;
}

interface ManagerWorkerCtx {
  id: string;
  projectName: string;
  name: string;
  mode: string;
  branch: string | null;
  baseRef: string | null;
  updatedAt?: string;
  /** The worker's plan; its state and conclusion stand in the index line. */
  plan?: WorkerPlanDto | null;
  /** How its last wake ended short, if it did; whether a wake of it runs now. */
  failure?: { at: string; kind: FailureKind } | null;
  running?: boolean;
}

export interface ManagerPromptInput {
  projects: ManagerProjectCtx[];
  /** This thread's workers. */
  workers: ManagerWorkerCtx[];
  /** Active workers other threads own: counted, not listed. */
  otherThreadWorkerCount?: number;
}

interface ManagerInitialContextInput {
  managerDir: string;
  agentPreferences?: string;
  /** The user's rules for the tool-call review while it is on, or empty. */
  toolReviewRules?: string;
  availableSkillsSection?: string;
  /** buildMemorySection's output: memory opens the window. */
  memorySection?: string;
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
    lines.push(`  - ${project.name} (id ${project.id}) - ${project.workerCount} worker(s)`);
  }
  const omitted = projects.length - visible.length;
  if (omitted > 0) {
    lines.push(`  - ${omitted} additional project(s) omitted from this compact digest.`);
  }
  return lines.join("\n");
}

function renderWorkers(workers: ManagerWorkerCtx[]): string {
  if (workers.length === 0) {
    return [
      "- Active workers: 0",
      "- No active workers."
    ].join("\n");
  }
  const visible = selectManagerWorkers(workers);
  const lines = [
    `- Active workers: ${workers.length}`,
    "- Exact worker state: call list_workers/get_worker_status; use read_worker_thread for deeper recent history.",
    "- Worker index (limited):"
  ];
  for (const worker of visible) {
    const branch = worker.branch ?? "(no branch)";
    const baseRef = worker.baseRef ? `, base ${worker.baseRef}` : "";
    const plan = renderWorkerPlan(worker.plan, worker.failure ?? null, worker.running ?? false);
    lines.push(`  - ${worker.name} (id ${worker.id}) in ${worker.projectName} - mode ${worker.mode}, branch ${branch}${baseRef}${plan}`);
  }
  const omitted = workers.length - visible.length;
  if (omitted > 0) {
    lines.push(`  - ${omitted} additional worker(s) omitted from this compact digest.`);
  }
  return lines.join("\n");
}

function renderManagerSummary(input: ManagerPromptInput): string {
  const shownWorkerCount = selectManagerWorkers(input.workers).length;
  return [
    `- Active projects: ${input.projects.length}`,
    `- This thread's active workers: ${input.workers.length}`,
    input.workers.length > shownWorkerCount
      ? `- Worker index shown below: ${shownWorkerCount} of ${input.workers.length}, prioritized by worker context freshness and recency.`
      : `- Worker index shown below: ${shownWorkerCount}`,
    `- Workers in other threads: ${input.otherThreadWorkerCount ?? 0} (not yours to direct; read them with list_workers, get_worker_status, read_plan)`,
    "- Runtime context is a compact routing digest. Use tools for authoritative current state."
  ].join("\n");
}

function selectManagerWorkers(workers: ManagerWorkerCtx[]): ManagerWorkerCtx[] {
  if (workers.length <= MANAGER_WORKER_LIMIT) return workers;
  return [...workers]
    .sort((a, b) => managerWorkerPriority(b) - managerWorkerPriority(a)
      || compareNullableStrings(a.projectName, b.projectName)
      || compareNullableStrings(a.name, b.name)
      || compareNullableStrings(a.id, b.id))
    .slice(0, MANAGER_WORKER_LIMIT);
}

function managerWorkerPriority(worker: ManagerWorkerCtx): number {
  return timestampScore(worker.plan?.updatedAt ?? worker.updatedAt);
}

function timestampScore(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareNullableStrings(a: string | undefined, b: string | undefined): number {
  return (a ?? "").localeCompare(b ?? "");
}

function renderWorkerPlan(plan: WorkerPlanDto | null | undefined, failure: { at: string; kind: FailureKind } | null, running: boolean): string {
  if (!plan) return "";
  const state = workerStateFor(plan, failure?.at ?? null, failure?.kind ?? null, running);
  const { done, total } = planProgress(plan);
  const conclusion = plan.conclusion ? oneLine(plan.conclusion) : "";
  const text = [WORKER_STATE_LABEL[state], total ? `${done}/${total}` : "", conclusion].filter(Boolean).join(" · ");
  return `; plan: ${limitPromptText(text, WORKER_PLAN_LINE_MAX_CHARS)}`;
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
    agentPreferencesSection: renderUserGuidance(input.agentPreferences, input.toolReviewRules),
    availableSkillsSection: renderAvailableSkillsSection(input.availableSkillsSection),
    memorySection: input.memorySection ?? ""
  });
}

export function buildManagerRuntimeContext(input: ManagerPromptInput): string {
  const tokens: Record<string, string> = {
    summarySection: renderManagerSummary(input),
    projectsSection: renderProjects(input.projects),
    workersSection: renderWorkers(input.workers)
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
