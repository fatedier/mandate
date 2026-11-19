import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "bun:test";
import { sourceFiles } from "./helpers/source-files.js";

// Agents could move the user's page (ui_navigate, canvas_open), open a link
// in it (ui_open_url) and ask it what it showed (ui_read_page_summary); the
// page reported its address as it changed, and every turn was told it. Built
// for a chat that rode along on every page, it pulled the page away from the
// conversation it was called in once a chat had a page of its own. All of it
// is gone. This fails if a piece of it comes back.
const SRC = path.join(import.meta.dir, "..", "src");
const FORBIDDEN = /uiLocation|UiLocation|ui_location|ui-context|uiContext|UiContext|UiPageSummary|useUiPageSummary|uiSummary|UiSummary|UI_ACTIONS|agentUiAction|UiAction|getClientId|clientId|UiRouteKind|UI_ROUTE_KINDS|ui-routes|\/api\/ui\/|Current User Page/;
// The tools' names: older chats draw their calls as any unknown tool's.
const TOOLS = /ui_navigate|ui_open_url|ui_read_page_summary|canvas_open/;

test("nothing of the agents' page control is left in src/, prompts and skills included", () => {
  const files = sourceFiles(SRC, /\.(ts|tsx|md)$/);
  // A walk that looked at nothing would read as a clean result.
  expect(files.length).toBeGreaterThan(300);
  expect(files.filter((file) => file.endsWith(".md")).length).toBeGreaterThan(5);
  const offenders: string[] = [];
  for (const file of files) {
    const rel = path.relative(SRC, file);
    fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (FORBIDDEN.test(line) || TOOLS.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 110)}`);
    });
  }
  expect(offenders).toStrictEqual([]);
});

test("the module, the skill and the page's handlers are not there", () => {
  for (const gone of [
    "server/modules/ui-context", "server/modules/skills/builtins/ui-routes", "shared/ui-context.ts", "shared/api/ui-context.ts",
    "client/lib/ui-context.ts", "client/routes/window/chat/ui-action-dispatcher.ts"
  ]) expect([gone, fs.existsSync(path.join(SRC, gone))]).toEqual([gone, false]);
});
