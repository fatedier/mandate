import type { SkillEntry } from "./skill-loader.js";
import type { SkillScope } from "./skill-frontmatter.js";
import { AVAILABLE_SKILLS_TAG, SKILL_TOOL_NAME } from "./skill-shared.js";
import type { LearnedSkill, LearnedSkillStore } from "./learned-skill-store.js";
import { learnedSkillLines, learnedSkillWhereText } from "./learned-skill-lines.js";

/** Where the learned skills come from, and what the lists need to name them. */
export interface LearnedSkillSource {
  store: LearnedSkillStore;
  projectName(id: string): string | null;
  /** The projects of the workers a thread owns or owned. */
  projectIdsOfThread(threadId: string): string[];
  /** An active project's id by its name; null when there is none. */
  projectIdByName(name: string): string | null;
  /** The conversation a review request names, if the requester may ask
   *  for it, with the range to review. */
  reviewTarget?: (requesterThreadId: string, ref: string | undefined) => import("./review-target.js").ReviewTarget | null;
  /** A review was queued: the job may start it. */
  reviewRequested?: () => void;
  /** Tells the owner of a change (a news notice). */
  notify?: (request: import("../notifications/notification-service.js").NotifyRequest) => void;
}

/** Whose learned skills a list shows: given projects (all of them for the
 *  personal agent), or those of a manager thread's workers. */
export type LearnedView = { projectIds: readonly string[] | "all" } | { threadId: string };

/** A learned skill as the `skill` tool hands it out. */
export type LearnedLoad = { kind: "loaded"; text: string; skill: LearnedSkill } | { kind: "archived"; text: string };

type SkillSourceLoader = () => Promise<SkillEntry[]>;

/** Whether an agent of this scope reads the skill. The personal agent ("personal")
 *  also reads what is written for managers, except Mandate's own skills,
 *  which serve tools it does not have. */
function reads(scope: SkillScope, e: SkillEntry): boolean {
  return e.scope.includes(scope) || (scope === "personal" && !e.builtIn && e.scope.includes("manager"));
}

export class SkillRegistry {
  /** Resolved entries indexed by name (later sources have already won). */
  private byName = new Map<string, SkillEntry>();
  /** Loaders the registry can call again to refresh from disk. Set via
   *  setLoaders(); empty until then so refresh() is a no-op. */
  private loaders: SkillSourceLoader[] = [];
  /** Wall-clock of the last time the byName map was rebuilt. The constructor
   *  treats its eager-load argument as the first refresh. */
  private lastRefreshMs = Date.now();
  private learned: LearnedSkillSource | null = null;
  /** The revision of each learned skill a thread loaded last (in memory: a
   *  restart means loading it again before changing it). */
  private loaded = new Map<string, Map<string, number>>();

  /**
   * @param sources Arrays in priority order — later sources override earlier
   *                ones on name conflict. Built-in first, user second, extras
   *                last is the canonical order. Pass `[]` if you'll populate
   *                via setLoaders() + refresh() instead.
   * @param appendices Text added after the body of the skill with that name,
   *                whichever source the skill came from: what a module's tools
   *                need an agent to know only while it does that skill's work.
   */
  constructor(sources: SkillEntry[][] = [], private readonly appendices: ReadonlyMap<string, () => string> = new Map()) {
    this.applySources(sources);
  }

  /** Wire loaders that will be re-invoked by refresh() / maybeRefresh().
   *  Call this once at startup if you want hot-reload semantics; otherwise
   *  the registry stays frozen at whatever was passed to the constructor. */
  setLoaders(loaders: SkillSourceLoader[]): void {
    this.loaders = loaders;
  }

  /** Re-invoke every registered loader, rebuild the byName map, reset
   *  the throttle timestamp. No-op if no loaders are wired. */
  async refresh(): Promise<void> {
    if (this.loaders.length === 0) return;
    const sources = await Promise.all(this.loaders.map((l) => l()));
    this.applySources(sources);
    this.lastRefreshMs = Date.now();
  }

  /** Refresh only if it's been more than `throttleMs` since the last
   *  refresh / construction. Cheap to call on every wake — within the
   *  window it's just a timestamp comparison. */
  async maybeRefresh(throttleMs: number): Promise<void> {
    if (Date.now() - this.lastRefreshMs < throttleMs) return;
    await this.refresh();
  }

  attachLearned(source: LearnedSkillSource): void {
    this.learned = source;
  }

  get learnedSource(): LearnedSkillSource | null {
    return this.learned;
  }

  /** A learned skill by name for an agent of `scope`: a worker only a global
   *  one or one of its project's; a manager or the personal agent any. A
   *  file skill of that name comes first (callers ask for files first). */
  loadLearned(name: string, scope: SkillScope, at: { threadId: string; projectId: string | null }): LearnedLoad | null {
    const skill = this.learned?.store.getByName(name);
    if (!skill || !this.learned) return null;
    if (scope === "worker" && skill.where.scope === "project" && skill.where.projectId !== at.projectId) return null;
    if (skill.status === "archived") return { kind: "archived", text: `The skill "${skill.name}" is archived and not in use: ${skill.archivedReason ?? ""}`.trimEnd() };
    this.learned.store.recordUse(skill.id, at.threadId, scope);
    this.noteLoaded(at.threadId, skill.id, skill.revision);
    const where = learnedSkillWhereText(skill, (id) => this.learned!.projectName(id));
    return { kind: "loaded", skill, text: `Learned skill (${where}, revision ${skill.revision}).\n\n${skill.body}` };
  }

  /** A thread now holds this revision of a learned skill (it loaded it, or
   *  wrote it). */
  noteLoaded(threadId: string, skillId: string, revision: number): void {
    const seen = this.loaded.get(threadId) ?? new Map<string, number>();
    seen.set(skillId, revision);
    this.loaded.set(threadId, seen);
  }

  /** The revision of a learned skill this thread loaded last; null if none. */
  loadedRevision(threadId: string, skillId: string): number | null {
    return this.loaded.get(threadId)?.get(skillId) ?? null;
  }

  getByScope(scope: SkillScope): SkillEntry[] {
    const out: SkillEntry[] = [];
    for (const e of this.byName.values()) {
      if (reads(scope, e)) out.push(e);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /** All entries regardless of scope. Used by the Settings UI which needs
   *  to surface every loaded skill, not just those visible to one agent. */
  listAll(): SkillEntry[] {
    return Array.from(this.byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Get an entry by name, scope-checked. Returns null if unknown OR if the
   *  caller's scope can't see it. Used by read_skill_reference to look up
   *  reference files. */
  getEntry(name: string, scope: SkillScope): SkillEntry | null {
    const e = this.byName.get(name);
    if (!e) return null;
    if (!reads(scope, e)) return null;
    return e;
  }

  async loadBody(name: string, scope: SkillScope): Promise<string | null> {
    const e = this.byName.get(name);
    if (!e) return null;
    if (!reads(scope, e)) return null;
    const body = await e.loadBody();
    const appendix = this.appendices.get(name);
    return appendix ? `${body.trimEnd()}\n\n${appendix()}` : body;
  }

  /**
   * Render the initial-context manifest for a given scope. Returns an empty
   * string when no skills are visible — callers concatenate without a trailing
   * newline check.
   */
  renderManifest(scope: SkillScope, view?: LearnedView): string {
    const entries = this.getByScope(scope);
    const learned = this.learnedLines(view);
    if (entries.length === 0 && learned.length === 0) return "";
    return [
      `<${AVAILABLE_SKILLS_TAG}>`,
      "The following skills are available. Each is a focused reference for a",
      "specific task. Read the description; if relevant to what the user is",
      `asking, call the ${SKILL_TOOL_NAME} tool to load the full content before acting.`,
      "",
      ...entries.map((e) => `- ${e.name}: ${e.description}`),
      ...learned,
      `</${AVAILABLE_SKILLS_TAG}>`
    ].join("\n");
  }

  private learnedLines(view: LearnedView | undefined): string[] {
    if (!this.learned || !view) return [];
    const projectIds = "threadId" in view ? this.learned.projectIdsOfThread(view.threadId) : view.projectIds;
    // A file skill of the same name wins: its learned namesake is not listed.
    const skills = this.learned.store.visible({ projectIds }).filter((s) => !this.byName.has(s.name));
    return learnedSkillLines(skills, (id) => this.learned!.projectName(id));
  }

  private applySources(sources: SkillEntry[][]): void {
    const next = new Map<string, SkillEntry>();
    for (const source of sources) {
      for (const e of source) {
        const prev = next.get(e.name);
        if (prev) {
          console.warn(`[skills] '${e.name}' overridden by ${e.sourcePath} (was ${prev.sourcePath})`);
        }
        next.set(e.name, e);
      }
    }
    this.byName = next;
  }
}
