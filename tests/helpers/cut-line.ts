import * as fs from "node:fs";

/** A text cut by cutKeepingWhole, read back: what was kept, the numbers its
 *  line (first, before what was kept) states, and the whole from the file it
 *  names (null without one). */
export function parseCut(text: string): { kept: string; first: number; of: number; whole: string | null } | null {
  const match = /^\[Cut: the first ([\d,]+) of ([\d,]+) characters\.(?: The whole text: ([^\n]+))?\]\n\n/.exec(text);
  if (!match) return null;
  const path = match[3];
  return {
    kept: text.slice(match[0].length),
    first: Number(match[1]!.replaceAll(",", "")),
    of: Number(match[2]!.replaceAll(",", "")),
    whole: path ? fs.readFileSync(path, "utf8") : null
  };
}
