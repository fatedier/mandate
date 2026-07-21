import type { SkillEntry } from "./skill-loader.js";
import type { SkillScope } from "./skill-frontmatter.js";
import { AVAILABLE_SKILLS_TAG, SKILL_TOOL_NAME } from "./skill-shared.js";

export type SkillSourceLoader = () => Promise<SkillEntry[]>;

export class SkillRegistry {
  /** Resolved entries indexed by name (later sources have already won). */
  private byName = new Map<string, SkillEntry>();
  /** Loaders the registry can call again to refresh from disk. Set via
   *  setLoaders(); empty until then so refresh() is a no-op. */
  private loaders: SkillSourceLoader[] = [];
  /** Wall-clock of the last time the byName map was rebuilt. The constructor
   *  treats its eager-load argument as the first refresh. */
  private lastRefreshMs = Date.now();

  /**
   * @param sources Arrays in priority order — later sources override earlier
   *                ones on name conflict. Built-in first, user second, extras
   *                last is the canonical order. Pass `[]` if you'll populate
   *                via setLoaders() + refresh() instead.
   */
  constructor(sources: SkillEntry[][] = []) {
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

  getByScope(scope: SkillScope): SkillEntry[] {
    const out: SkillEntry[] = [];
    for (const e of this.byName.values()) {
      if (e.scope.includes(scope)) out.push(e);
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
    if (!e.scope.includes(scope)) return null;
    return e;
  }

  async loadBody(name: string, scope: SkillScope): Promise<string | null> {
    const e = this.byName.get(name);
    if (!e) return null;
    if (!e.scope.includes(scope)) return null;
    return await e.loadBody();
  }

  /**
   * Render the initial-context manifest for a given scope. Returns an empty
   * string when no skills are visible — callers concatenate without a trailing
   * newline check.
   */
  renderManifest(scope: SkillScope): string {
    const entries = this.getByScope(scope);
    if (entries.length === 0) return "";
    return [
      `<${AVAILABLE_SKILLS_TAG}>`,
      "The following skills are available. Each is a focused reference for a",
      "specific task. Read the description; if relevant to what the user is",
      `asking, call the ${SKILL_TOOL_NAME} tool to load the full content before acting.`,
      "",
      ...entries.map((e) => `- ${e.name}: ${e.description}`),
      `</${AVAILABLE_SKILLS_TAG}>`
    ].join("\n");
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
