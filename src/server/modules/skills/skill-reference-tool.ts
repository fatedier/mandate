import * as fs from "node:fs";
import { z } from "zod";
import type { ToolDefinition } from "../agent/tool-registry.js";
import type { SkillRegistry } from "./skill-registry.js";
import type { SkillScope } from "./skill-frontmatter.js";

const params = z.object({
  skill: z.string().describe("The skill name (must appear in the available-skills list)."),
  path: z.string().describe("Reference file path relative to the skill's references/ directory (e.g. 'advanced.md').")
});

type ReferenceResult = string | { error: string };

const MAX_REFERENCE_BYTES = 256 * 1024; // 256 KB hard cap — references are docs, not data dumps

export function buildSkillReferenceTool(
  registry: SkillRegistry,
  scope: SkillScope
): ToolDefinition<z.infer<typeof params>, ReferenceResult> {
  return {
    name: "read_skill_reference",
    description:
      "Read a file from a skill's references/ directory. Use after loading a skill via the skill tool when its body points at additional reference content (e.g. 'see references/advanced.md').",
    parameters: params,
    approval: "never",
    handler: async ({ skill, path: relpath }) => {
      const entry = registry.getEntry(skill, scope);
      if (!entry) return { error: `Unknown skill: ${skill}` };
      const resolved = entry.resolveReference(relpath);
      if (!resolved) {
        return { error: `Reference not found: ${skill}/references/${relpath}` };
      }
      let raw: string;
      try {
        raw = fs.readFileSync(resolved, "utf8");
      } catch (err) {
        return { error: `Could not read reference: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (raw.length > MAX_REFERENCE_BYTES) {
        return {
          error: `Reference too large (${raw.length} bytes, max ${MAX_REFERENCE_BYTES}). Split into smaller files.`
        };
      }
      return raw;
    }
  };
}
