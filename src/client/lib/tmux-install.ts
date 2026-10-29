export const TMUX_INSTALL_HINT = [
  "Install tmux, then refresh.",
  "macOS: brew install tmux",
  "Ubuntu/Debian: sudo apt install tmux"
].join("\n");

export function isTmuxMissingError(error: string): boolean {
  const lower = error.toLowerCase();
  return lower.includes("tmux") && (
    lower.includes("executable not found") ||
    lower.includes("not found in $path") ||
    lower.includes("enoent")
  );
}

export function withTmuxInstallHint(error: string): string {
  if (!isTmuxMissingError(error)) return error;
  return `${error}\n\n${TMUX_INSTALL_HINT}`;
}
