import * as fs from "node:fs";
import * as path from "node:path";
import { parseSkillFrontmatter, type SkillScope } from "./skill-frontmatter.js";

export interface SkillEntry {
  name: string;
  description: string;
  scope: SkillScope[];
  /** Absolute path to the SKILL.md the entry came from. Used for log lines and override messages. */
  sourcePath: string;
  /** Read and return the body. Re-reads on every call (cheap). */
  loadBody: () => Promise<string>;
  /** Resolve a `references/<relpath>` request to a readable absolute path
   *  (a real disk path for user/extra skills, a /$bunfs/ path for embedded
   *  built-ins). Returns null when the file isn't part of the skill or the
   *  relpath escapes the references/ subdir. */
  resolveReference: (relpath: string) => string | null;
}

const SKILL_FILE = "SKILL.md";
const BODY_LINE_SOFT_CAP = 500;

/**
 * Scan a directory for `*\/SKILL.md` and return one entry per valid skill.
 * Top-level subdirectories only — nested `foo/bar/SKILL.md` is ignored
 * (matches the Anthropic convention).
 *
 * Errors during scan are logged and skipped, never thrown — the loader is
 * called at server start and a bad user skill must not abort startup.
 */
export async function loadSkillsFromDir(root: string): Promise<SkillEntry[]> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: SkillEntry[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(root, ent.name);
    const skillPath = path.join(dir, SKILL_FILE);
    if (!fs.existsSync(skillPath)) {
      // Subdirectories without a SKILL.md are common (e.g. references-only
      // dropped in by accident) — not a skill, silently skip.
      continue;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(skillPath, "utf8");
    } catch (err) {
      console.warn(`[skills] could not read ${skillPath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const parsed = parseSkillFrontmatter(raw);
    if (!parsed.ok) {
      console.warn(`[skills] skipping ${skillPath}: ${parsed.error}`);
      continue;
    }
    if (parsed.value.name !== ent.name) {
      console.warn(`[skills] ${skillPath}: frontmatter name '${parsed.value.name}' does not match directory '${ent.name}' — using frontmatter name`);
    }
    if (parsed.value.bodyLineCount > BODY_LINE_SOFT_CAP) {
      console.warn(`[skills] ${skillPath}: body is ${parsed.value.bodyLineCount} lines (soft cap ${BODY_LINE_SOFT_CAP}) — consider splitting into references/`);
    }
    const referencesDir = path.resolve(dir, "references");
    out.push({
      name: parsed.value.name,
      description: parsed.value.description,
      scope: parsed.value.scope,
      sourcePath: skillPath,
      loadBody: async () => {
        const fresh = fs.readFileSync(skillPath, "utf8");
        const reparsed = parseSkillFrontmatter(fresh);
        return reparsed.ok ? reparsed.value.body : "";
      },
      resolveReference: (relpath: string) => {
        // Reject absolute paths outright; let path.resolve normalise the
        // rest, then re-check the result is still inside referencesDir.
        if (path.isAbsolute(relpath)) return null;
        const target = path.resolve(referencesDir, relpath);
        if (target !== referencesDir && !target.startsWith(referencesDir + path.sep)) return null;
        if (!fs.existsSync(target)) return null;
        const stat = fs.statSync(target);
        if (!stat.isFile()) return null;
        return target;
      }
    });
  }
  return out;
}

/**
 * Load the built-in skills shipped with Mandate. In compiled binaries this
 * resolves the virtual `mandate-skills.gen.ts` module produced by
 * scripts/build-binary.ts, which statically imports every built-in SKILL.md
 * via `with { type: "file" }`. In dev (`bun --watch`) the virtual module
 * doesn't exist; we fall back to scanning `src/server/modules/skills/builtins`
 * on disk.
 */
export async function loadBuiltinSkills(srcFallbackDir: string): Promise<SkillEntry[]> {
  let manifest: Record<string, string> | null = null;
  try {
    // @ts-expect-error - virtual module produced at compile time
    const mod = await import("mandate-skills.gen.ts");
    manifest = (mod.default ?? mod) as Record<string, string>;
  } catch {
    manifest = null;
  }
  if (!manifest) {
    return loadSkillsFromDir(srcFallbackDir);
  }
  return parseManifestEntries(manifest);
}

function parseManifestEntries(manifest: Record<string, string>): SkillEntry[] {
  // Group every embedded file by its top-level skill dir so we can give
  // each skill a closure that knows its references/* siblings without
  // string-arithmetic on the /$bunfs/ paths (those are hashed by Bun and
  // can't be derived from the original relpath).
  const filesPerSkill = new Map<string, Map<string, string>>();
  for (const [relpath, embeddedPath] of Object.entries(manifest)) {
    const segments = relpath.split("/");
    if (segments.length < 2) continue;
    const dirName = segments[0]!;
    const inSkill = segments.slice(1).join("/");
    if (!filesPerSkill.has(dirName)) filesPerSkill.set(dirName, new Map());
    filesPerSkill.get(dirName)!.set(inSkill, embeddedPath);
  }

  const out: SkillEntry[] = [];
  for (const [dirName, files] of filesPerSkill) {
    const embeddedPath = files.get(SKILL_FILE);
    if (!embeddedPath) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(embeddedPath, "utf8");
    } catch (err) {
      console.warn(`[skills] could not read embedded ${embeddedPath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const parsed = parseSkillFrontmatter(raw);
    if (!parsed.ok) {
      console.warn(`[skills] skipping embedded ${dirName}/${SKILL_FILE}: ${parsed.error}`);
      continue;
    }
    if (parsed.value.name !== dirName) {
      console.warn(`[skills] embedded ${dirName}/${SKILL_FILE}: frontmatter name '${parsed.value.name}' does not match directory '${dirName}' — using frontmatter name`);
    }
    if (parsed.value.bodyLineCount > BODY_LINE_SOFT_CAP) {
      console.warn(`[skills] embedded ${dirName}/${SKILL_FILE}: body is ${parsed.value.bodyLineCount} lines (soft cap ${BODY_LINE_SOFT_CAP})`);
    }
    // /$bunfs/ paths are frozen at compile time — content can never change,
    // so cache the parsed body after the first read instead of re-parsing on
    // every skill tool invocation.
    let cachedBody: string | null = null;
    out.push({
      name: parsed.value.name,
      description: parsed.value.description,
      scope: parsed.value.scope,
      sourcePath: embeddedPath,
      loadBody: async () => {
        if (cachedBody !== null) return cachedBody;
        const fresh = fs.readFileSync(embeddedPath, "utf8");
        const reparsed = parseSkillFrontmatter(fresh);
        cachedBody = reparsed.ok ? reparsed.value.body : "";
        return cachedBody;
      },
      resolveReference: (relpath: string) => {
        // Only allow lookups under references/. Reject `..` traversal by
        // normalising the relpath and rejecting if it tries to leave.
        if (path.isAbsolute(relpath)) return null;
        const normalised = path.posix.normalize(`references/${relpath}`);
        if (normalised.startsWith("..") || normalised === ".") return null;
        return files.get(normalised) ?? null;
      }
    });
  }
  return out;
}
