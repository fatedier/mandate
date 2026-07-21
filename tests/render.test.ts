import { expect, test } from "bun:test";
import { getPaneDisplayCommand } from "../src/client/lib/render.js";
import { compactPath, formatRelativeTime } from "../src/client/lib/format.js";
import { parseTmuxLayout } from "../src/client/lib/tmux.js";

test("getPaneDisplayCommand unwraps node-based CLI commands", () => {
  const pane = {
    currentCommand: "node",
    foregroundProcesses: [
      { command: "node /Users/alice/.nvm/versions/node/v22.22.0/bin/codex" }
    ]
  };
  expect(getPaneDisplayCommand(pane)).toBe("codex");
});

test("getPaneDisplayCommand handles Linux home paths", () => {
  const pane = {
    currentCommand: "node",
    foregroundProcesses: [
      { command: "node /home/alice/.nvm/versions/node/v22.22.0/bin/codex" }
    ]
  };
  expect(getPaneDisplayCommand(pane)).toBe("codex");
});

test("getPaneDisplayCommand handles Windows-style paths from WSL-like output", () => {
  const pane = {
    currentCommand: "node",
    foregroundProcesses: [
      { command: "node C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.cmd" }
    ]
  };
  expect(getPaneDisplayCommand(pane)).toBe("codex");
});

test("getPaneDisplayCommand unwraps node options before script path", () => {
  const pane = {
    currentCommand: "node",
    foregroundProcesses: [
      { command: "node --watch src/server/server.ts" }
    ]
  };
  expect(getPaneDisplayCommand(pane)).toBe("server.ts");
});

test("getPaneDisplayCommand unwraps package manager exec commands", () => {
  const pane = {
    currentCommand: "npm",
    foregroundProcesses: [
      { command: "npm exec @playwright/mcp@latest --headless --isolated" }
    ]
  };
  expect(getPaneDisplayCommand(pane)).toBe("mcp");
});

test("getPaneDisplayCommand keeps package manager run scripts readable", () => {
  const pane = {
    currentCommand: "npm",
    foregroundProcesses: [
      { command: "npm run dev" }
    ]
  };
  expect(getPaneDisplayCommand(pane)).toBe("npm:dev");
});

test("getPaneDisplayCommand unwraps python modules and scripts", () => {
  expect(getPaneDisplayCommand({
    currentCommand: "python3",
    foregroundProcesses: [{ command: "python3 -m pytest tests" }]
  })).toBe("pytest");
  expect(getPaneDisplayCommand({
    currentCommand: "python",
    foregroundProcesses: [{ command: "python scripts/worker.py" }]
  })).toBe("worker.py");
});

test("compactPath handles common home directory formats", () => {
  expect(compactPath("/Users/alice/projects/mandate")).toBe("~/projects/mandate");
  expect(compactPath("/home/alice/projects/mandate")).toBe("~/projects/mandate");
  expect(compactPath("/var/home/alice/projects/mandate")).toBe("~/projects/mandate");
  expect(compactPath("C:\\Users\\alice\\projects\\mandate")).toBe("~/projects/mandate");
});

test("formatRelativeTime: < 30s = just now", () => {
  const now = 1_000_000_000_000;
  expect(formatRelativeTime(now - 5_000, now)).toBe("just now");
  expect(formatRelativeTime(now - 29_000, now)).toBe("just now");
  expect(formatRelativeTime(now - 59_000, now)).toBe("just now");
});

test("formatRelativeTime: 30s - 60min = Nm ago", () => {
  const now = 1_000_000_000_000;
  expect(formatRelativeTime(now - 60_000, now)).toBe("1m ago");
  expect(formatRelativeTime(now - 3 * 60_000, now)).toBe("3m ago");
  expect(formatRelativeTime(now - 59 * 60_000, now)).toBe("59m ago");
});

test("formatRelativeTime: 1h - 24h = Nh ago", () => {
  const now = 1_000_000_000_000;
  expect(formatRelativeTime(now - 60 * 60_000, now)).toBe("1h ago");
  expect(formatRelativeTime(now - 5 * 60 * 60_000, now)).toBe("5h ago");
});

test("formatRelativeTime: > 24h = Nd ago", () => {
  const now = 1_000_000_000_000;
  expect(formatRelativeTime(now - 24 * 60 * 60_000, now)).toBe("1d ago");
  expect(formatRelativeTime(now - 3 * 24 * 60 * 60_000, now)).toBe("3d ago");
});

test("formatRelativeTime: missing timestamp → empty string", () => {
  expect(formatRelativeTime(null, Date.now())).toBe("");
  expect(formatRelativeTime(undefined, Date.now())).toBe("");
  expect(formatRelativeTime(0, Date.now())).toBe("");
  expect(formatRelativeTime("not a date", Date.now())).toBe("");
});

test("formatRelativeTime: ISO timestamp", () => {
  expect(formatRelativeTime("2026-04-29T08:00:00.000Z", Date.parse("2026-04-29T08:03:00.000Z"))).toBe("3m ago");
});

test("parseTmuxLayout parses nested tmux split coordinates", () => {
  const layout = "424d,173x40,0,0{86x40,0,0[86x19,0,0,6,86x20,0,20,7],86x40,87,0[86x19,87,0{49x19,87,0,8,36x19,137,0,9},86x20,87,20,10]}";
  const parsed = parseTmuxLayout(layout);
  expect(parsed.width).toBe(173);
  expect(parsed.height).toBe(40);
  expect(parsed.leaves.map((leaf) => leaf.layoutPaneId)).toEqual(["6", "7", "8", "9", "10"]);
  expect(parsed.leaves[2]).toEqual({ layoutPaneId: "8", x: 87, y: 0, width: 49, height: 19 });
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
