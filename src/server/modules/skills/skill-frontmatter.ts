import matter from "gray-matter";
import { errorText } from "../../../shared/error-text.js";

/** Who reads a skill: managers, workers, or Your agent ("global"). */
export type SkillScope = "manager" | "worker" | "global";
const VALID_SCOPES: readonly SkillScope[] = ["manager", "worker", "global"];

interface ParsedSkill {
  name: string;
  description: string;
  scope: SkillScope[];
  body: string;
  bodyLineCount: number;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseSkillFrontmatter(source: string): Parsed<ParsedSkill> {
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(source);
  } catch (err) {
    return { ok: false, error: `failed to parse frontmatter: ${errorText(err)}` };
  }

  const data = parsed.data as Record<string, unknown>;
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (!name) return { ok: false, error: "frontmatter is missing required field 'name'" };
  if (!description) return { ok: false, error: "frontmatter is missing required field 'description'" };

  // scope: optional. May be omitted (default = every scope), a string ("manager"),
  // or an array (["manager", "worker"]). Normalise to SkillScope[].
  const rawScope = data.scope;
  let scope: SkillScope[];
  if (rawScope === undefined || rawScope === null) {
    scope = [...VALID_SCOPES];
  } else if (typeof rawScope === "string") {
    scope = [rawScope as SkillScope];
  } else if (Array.isArray(rawScope)) {
    scope = rawScope.map((s) => String(s)) as SkillScope[];
  } else {
    return { ok: false, error: `frontmatter 'scope' must be a string or array, got ${typeof rawScope}` };
  }
  for (const s of scope) {
    if (!VALID_SCOPES.includes(s)) {
      return { ok: false, error: `frontmatter 'scope' contains invalid value '${s}' (allowed: ${VALID_SCOPES.join(", ")})` };
    }
  }

  const body = parsed.content;
  // Lines INCLUDING blank lines, matching what a human would see in an editor.
  // Used by the loader to enforce the 500-line soft cap.
  const bodyLineCount = body.split(/\r?\n/).length;
  return { ok: true, value: { name, description, scope, body, bodyLineCount } };
}
