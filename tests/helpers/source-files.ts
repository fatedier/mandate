import * as fs from "node:fs";
import * as path from "node:path";

/** Every file under `dir` whose name matches `pattern`, sorted: what the
 *  residue tests read. Fewer than `atLeast` throws, so a wrong root or a
 *  renamed extension cannot read as a clean result. */
export function sourceFiles(dir: string, pattern: RegExp, atLeast = 1): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (pattern.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  if (out.length < atLeast) throw new Error(`sourceFiles: ${out.length} file(s) under ${dir} match ${pattern}, fewer than ${atLeast}`);
  return out.sort();
}
