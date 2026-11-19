import { expect, test } from "bun:test";
import { isTmuxMissingError, withTmuxInstallHint } from "../src/client/lib/tmux-install.js";

test("detects missing tmux executable errors", () => {
  expect(isTmuxMissingError('Executable not found in $PATH: "tmux"')).toBe(true);
  expect(isTmuxMissingError("spawn tmux ENOENT")).toBe(true);
  expect(isTmuxMissingError("tmux new-session failed")).toBe(false);
});

test("adds install commands to missing tmux errors", () => {
  const message = withTmuxInstallHint('Executable not found in $PATH: "tmux"');
  expect(message).toContain("macOS: brew install tmux");
  expect(message).toContain("Ubuntu/Debian: sudo apt install tmux");
});
