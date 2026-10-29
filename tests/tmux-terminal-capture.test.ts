import { expect, test } from "bun:test";
import { capturePaneInitial, capturePaneRefresh } from "../src/server/runtime/runtimes/tmux-terminal-capture.js";
import type { TmuxClient } from "../src/server/platform/tmux/tmux.js";

// A fake tmux: display-message answers "<alternate_on> <cursor_x> <cursor_y>",
// capture-pane answers the screen. Every call's arguments are kept.
function fakeTmux(state: string, screen: string, captureStatus = 0) {
  const calls: string[][] = [];
  const client: TmuxClient = {
    socketArgs: [],
    runner: {
      run: (_cmd, args) => {
        calls.push(args);
        if (args[0] === "display-message") return { status: 0, signal: null, stdout: state, stderr: "" };
        return { status: captureStatus, signal: null, stdout: screen, stderr: "" };
      }
    }
  };
  const captureArgs = () => calls.find((args) => args[0] === "capture-pane");
  return { client, captureArgs };
}

const initial = (history: number) => (client: TmuxClient) => capturePaneInitial(client, "%1", history);
const refresh = (history?: number) => (client: TmuxClient) => capturePaneRefresh(client, "%1", history);

// state is what display-message answers, screen what capture-pane answers;
// bytes is the paint, and start the capture's -S (how much history it asks for).
const paints: { name: string; state: string; screen: string; paint: (client: TmuxClient) => string | null; bytes: string; start: string }[] = [
  { name: "the first paint carries the history and puts the cursor back",
    state: "0 4 2", screen: "a\nb\n", paint: initial(1000), bytes: "a\r\nb\x1b[3;5H", start: "-1000" },
  { name: "the first paint of a full-screen app enters the alternate screen and dumps only what is visible",
    state: "1 0 0", screen: "top\n", paint: initial(1000), bytes: "\x1b[?1049h\x1b[2J\x1b[Htop\x1b[1;1H", start: "0" },
  { name: "a refresh repaints the visible screen on the main screen",
    state: "0 1 0", screen: "x\n", paint: refresh(), bytes: "\x1b[?1049l\x1b[0m\x1b[2J\x1b[Hx\x1b[0m\x1b[1;2H", start: "0" },
  { name: "a refresh with history also clears the scrollback it replaces",
    state: "0 0 0", screen: "x\n", paint: refresh(500), bytes: "\x1b[?1049l\x1b[0m\x1b[3J\x1b[2J\x1b[Hx\x1b[0m\x1b[1;1H", start: "-500" },
  { name: "a refresh of a full-screen app ignores the history it was asked for",
    state: "1 2 3", screen: "x\n", paint: refresh(500), bytes: "\x1b[?1049h\x1b[0m\x1b[2J\x1b[Hx\x1b[0m\x1b[4;3H", start: "0" }
];

test.each(paints)("$name", ({ state, screen, paint, bytes, start }) => {
  const tmux = fakeTmux(state, screen);
  expect(paint(tmux.client)).toBe(bytes);
  expect(tmux.captureArgs()).toEqual(["capture-pane", "-p", "-e", "-J", "-t", "%1", "-S", start, "-E", "-"]);
});

test("a capture tmux refuses paints nothing", () => {
  expect(capturePaneInitial(fakeTmux("0 0 0", "", 1).client, "%1", 1000)).toBeNull();
  expect(capturePaneRefresh(fakeTmux("0 0 0", "", 1).client, "%1")).toBeNull();
});
