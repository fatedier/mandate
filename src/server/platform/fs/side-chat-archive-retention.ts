import * as fs from "node:fs";
import * as path from "node:path";
import { logError } from "../logger.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The side chats sent to the personal agent are kept for `maxAgeDays` after they
 *  were written (30 by default), then deleted. A folder not made yet is
 *  nothing to do. */
export function sweepSideChatArchives(input: { dir: string; now: Date; maxAgeDays?: number }): { deleted: number } {
  const oldBefore = input.now.getTime() - (input.maxAgeDays ?? 30) * DAY_MS;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(input.dir, { withFileTypes: true });
  } catch {
    return { deleted: 0 };
  }
  let deleted = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = path.join(input.dir, entry.name);
    try {
      if (fs.statSync(file).mtimeMs >= oldBefore) continue;
      fs.unlinkSync(file);
      deleted += 1;
    } catch (err) {
      // Gone between the listing and now: nothing to do.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") logError("side chat retention", err, `could not delete ${file}`);
    }
  }
  return { deleted };
}
