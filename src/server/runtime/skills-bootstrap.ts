import path from "node:path";
import type { SkillSummaryDto, SkillSource } from "../../shared/api-contracts.js";
import { loadBuiltinSkills, loadSkillsFromDir } from "../modules/skills/skill-loader.js";
import { SkillRegistry } from "../modules/skills/skill-registry.js";
import { moduleSkillAppendices } from "../modules/registry.js";
import { expandHome } from "../platform/fs/data-dir.js";

interface SkillsBootstrapDeps {
  /** Directory holding `modules/skills/builtins` — passed in so the resolution
   *  matches whichever entrypoint is running (server.ts vs. tests). */
  builtinSkillsDir: string;
  /** `<dataDir>/skills` — the user's drop-in directory. */
  userSkillsDir: string;
  /** config.json's skills.extraDirs, each an absolute path. */
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
  const registry = new SkillRegistry([builtinSkills, userSkills, extraSkills], moduleSkillAppendices());
  registry.setLoaders([builtinLoader, userLoader, extraLoader]);

  logBootSummary(builtinSkills, userSkills, extraSkills, deps.userSkillsDir);

  const classify = (sourcePath: string): SkillSource => {
    if (sourcePath.startsWith("/$bunfs/") || inside(deps.builtinSkillsDir, sourcePath)) return "builtin";
    if (inside(deps.userSkillsDir, sourcePath)) return "user";
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

/** Whether `file` is in folder `dir` (a sibling whose name starts the same
 *  is not). */
function inside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Resolve `<dataDir>/skills` and config.json's extra folders into the
 *  inputs above. */
export function resolveSkillsDirs(opts: {
  builtinSkillsDir: string;
  dataDir: string;
  /** config.json's skills.extraDirs: `~/` is the home directory, a relative
   *  one is inside the data dir. */
  extraDirs: string[];
}): SkillsBootstrapDeps {
  return {
    builtinSkillsDir: opts.builtinSkillsDir,
    userSkillsDir: path.join(opts.dataDir, "skills"),
    extraSkillsDirs: opts.extraDirs.map((dir) => path.resolve(opts.dataDir, expandHome(dir)))
  };
}
