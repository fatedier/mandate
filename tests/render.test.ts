import { expect, test } from "bun:test";
import { getPaneDisplayCommand } from "../src/client/lib/render.js";
import { parseTmuxLayout } from "../src/client/lib/tmux.js";

// currentCommand is what tmux reports; command is the pane's one foreground
// process; display is the name the pane is shown under.
const displayCases = [
  { name: "handles Windows-style paths from WSL-like output", currentCommand: "node", command: "node C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.cmd", display: "codex" },
  { name: "unwraps node options before script path", currentCommand: "node", command: "node --watch src/server/server.ts", display: "server.ts" },
  { name: "unwraps package manager exec commands", currentCommand: "npm", command: "npm exec @playwright/mcp@latest --headless --isolated", display: "mcp" },
  { name: "keeps package manager run scripts readable", currentCommand: "npm", command: "npm run dev", display: "npm:dev" },
  { name: "unwraps python modules", currentCommand: "python3", command: "python3 -m pytest tests", display: "pytest" },
  { name: "unwraps python scripts", currentCommand: "python", command: "python scripts/worker.py", display: "worker.py" }
];

test.each(displayCases)("getPaneDisplayCommand $name", ({ currentCommand, command, display }) => {
  expect(getPaneDisplayCommand({ currentCommand, foregroundProcesses: [{ command }] })).toBe(display);
});

test("parseTmuxLayout reads an empty layout as no layout, not an error", () => {
  expect([parseTmuxLayout(""), parseTmuxLayout("   "), parseTmuxLayout(null), parseTmuxLayout(undefined)]).toEqual([null, null, null, null]);
});

test("parseTmuxLayout parses nested tmux split coordinates", () => {
  const layout = "424d,173x40,0,0{86x40,0,0[86x19,0,0,6,86x20,0,20,7],86x40,87,0[86x19,87,0{49x19,87,0,8,36x19,137,0,9},86x20,87,20,10]}";
  const parsed = parseTmuxLayout(layout);
  expect(parsed!.width).toBe(173);
  expect(parsed!.height).toBe(40);
  expect(parsed!.leaves.map((leaf) => leaf.layoutPaneId)).toEqual(["6", "7", "8", "9", "10"]);
  expect(parsed!.leaves[2]).toEqual({ layoutPaneId: "8", x: 87, y: 0, width: 49, height: 19 });
});

test("parseTmuxLayout parses a single pane layout", () => {
  const parsed = parseTmuxLayout("bb62,159x48,0,0,12");
  expect(parsed).toEqual({
    x: 0,
    y: 0,
    width: 159,
    height: 48,
    leaves: [{ layoutPaneId: "12", x: 0, y: 0, width: 159, height: 48 }]
  });
});
