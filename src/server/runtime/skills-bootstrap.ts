import path from "node:path";
import type { SkillSummaryDto, SkillSource } from "../../shared/api-contracts.js";
import { loadBuiltinSkills, loadSkillsFromDir } from "../modules/skills/skill-loader.js";
import { SkillRegistry } from "../modules/skills/skill-registry.js";

export interface SkillsBootstrapDeps {
  /** Directory holding `modules/skills/builtins` — passed in so the resolution
   *  matches whichever entrypoint is running (server.ts vs. tests). */
  builtinSkillsDir: string;
  /** `<dataDir>/skills` — the user's drop-in directory. */
  userSkillsDir: string;
  /** Colon-separated `MANDATE_SKILLS_DIR` env value, parsed to a list. */
  extraSkillsDirs: string[];
}

export interface SkillsBootstrapResult {
  registry: SkillRegistry;
  /** For the HTTP /api/skills response — bundles the registry list with
   *  per-skill source classification (builtin / user / extra). */
  list: () => SkillSummaryDto[];
  refresh: () => Promise<void>;
}

/** Eagerly load all three skill sources, log what was found, then wire up
 *  the registry's lazy-refresh loaders so subsequent wakes can pick up new
 *  user skills (throttled by the registry itself). */
export async function bootstrapSkills(deps: SkillsBootstrapDeps): Promise<SkillsBootstrapResult> {
  const builtinLoader = () => loadBuiltinSkills(deps.builtinSkillsDir);
  const userLoader = () => loadSkillsFromDir(deps.userSkillsDir);
  const extraLoader = async () =>
    (await Promise.all(deps.extraSkillsDirs.map(loadSkillsFromDir))).flat();

  // Eager initial load so the boot log can show what was found.
  const builtinSkills = await builtinLoader();
  const userSkills = await userLoader();
  const extraSkills = await extraLoader();
  const registry = new SkillRegistry([builtinSkills, userSkills, extraSkills]);
  registry.setLoaders([builtinLoader, userLoader, extraLoader]);

  logBootSummary(builtinSkills, userSkills, extraSkills, deps.userSkillsDir);

  const classify = (sourcePath: string): SkillSource => {
    if (sourcePath.startsWith("/$bunfs/") || sourcePath.startsWith(deps.builtinSkillsDir)) return "builtin";
    if (sourcePath.startsWith(deps.userSkillsDir)) return "user";
    return "extra";
  };

  return {
    registry,
    list: () => registry.listAll().map((s) => ({
      name: s.name,
      description: s.description,
      scope: s.scope,
      source: classify(s.sourcePath),
      sourcePath: s.sourcePath
    })),
    refresh: () => registry.refresh()
  };
}

function logBootSummary(
  builtin: Array<{ name: string }>,
  user: Array<{ name: string }>,
  extra: Array<{ name: string }>,
  userSkillsDir: string
): void {
  const total = builtin.length + user.length + extra.length;
  if (total === 0) {
    console.log(`[skills] loaded 0 skills (drop SKILL.md files into ${userSkillsDir} to add some)`);
    return;
  }
  // At small skill counts list the names so the operator can verify what
  // loaded at a glance. Past a threshold names get noisy, fall back to counts.
  if (total <= 5) {
    const tagged = [
      ...builtin.map((s) => `${s.name} (builtin)`),
      ...user.map((s) => `${s.name} (user)`),
      ...extra.map((s) => `${s.name} (extra)`)
    ];
    console.log(`[skills] loaded: ${tagged.join(", ")}`);
  } else {
    console.log(`[skills] loaded ${builtin.length} builtin + ${user.length} user + ${extra.length} extra skill(s)`);
  }
}

/** Resolve `<dataDir>/skills` and the extras-dir env into the inputs above. */
export function resolveSkillsDirs(opts: {
  builtinSkillsDir: string;
  dataDir: string;
  extraSkillsDirsEnv: string | undefined;
}): SkillsBootstrapDeps {
  return {
    builtinSkillsDir: opts.builtinSkillsDir,
    userSkillsDir: path.join(opts.dataDir, "skills"),
    extraSkillsDirs: (opts.extraSkillsDirsEnv ?? "")
      .split(":").map((s) => s.trim()).filter(Boolean)
  };
}
