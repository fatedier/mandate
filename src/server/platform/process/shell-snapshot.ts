import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Ported from codex-rs core/src/shell_snapshot.rs: capture the user's login
// shell environment once, then source that snapshot before each bash-tool
// command so commands see the same PATH/env as the user's terminal.

export type UserShellType = "zsh" | "bash" | "sh";

export interface UserShell {
  path: string;
  type: UserShellType;
}

const SNAPSHOT_MARKER = "# Snapshot file";
const SNAPSHOT_TIMEOUT_MS = 10000;
const EXCLUDED_EXPORTS = "PWD|OLDPWD";

const SHELL_TYPES: Record<string, UserShellType> = {
  zsh: "zsh",
  bash: "bash",
  sh: "sh"
};

function classifyShell(shellPath: string | null | undefined): UserShell | null {
  if (!shellPath) return null;
  const type = SHELL_TYPES[path.basename(shellPath)];
  if (!type) return null;
  return { path: shellPath, type };
}

function passwdShell(): string | null {
  try {
    return os.userInfo().shell;
  } catch {
    return null;
  }
}

export function detectUserShell(
  opts: { passwdShell?: string | null; env?: Record<string, string | undefined> } = {}
): UserShell {
  const fromPasswd = classifyShell("passwdShell" in opts ? opts.passwdShell : passwdShell());
  if (fromPasswd) return fromPasswd;
  const fromEnv = classifyShell((opts.env ?? process.env).SHELL);
  if (fromEnv) return fromEnv;
  return { path: "/bin/bash", type: "bash" };
}

export function shellSingleQuote(value: string): string {
  return value.replaceAll("'", "'\\''");
}

const ZSH_SNAPSHOT_SCRIPT = String.raw`if [[ -n "$ZDOTDIR" ]]; then
  rc="$ZDOTDIR/.zshrc"
else
  rc="$HOME/.zshrc"
fi
[[ -r "$rc" ]] && . "$rc"
print '# Snapshot file'
print '# Unset all aliases to avoid conflicts with functions'
print 'unalias -a 2>/dev/null || true'
print '# Functions'
functions
print ''
setopt_count=$(setopt | wc -l | tr -d ' ')
print "# setopts $setopt_count"
setopt | sed 's/^/setopt /'
print ''
alias_count=$(alias -L | wc -l | tr -d ' ')
print "# aliases $alias_count"
alias -L
print ''
export_lines=$(export -p | awk '
/^(export|declare -x|typeset -x) / {
  line=$0
  name=line
  sub(/^(export|declare -x|typeset -x) /, "", name)
  if (name ~ /^-[A-Za-z]*r[A-Za-z]* /) {
    next
  }
  if (name ~ /^-[A-Za-z]*T[A-Za-z]* /) {
    sub(/^-[A-Za-z]*T[A-Za-z]* /, "", name)
    sub(/ [A-Za-z_][A-Za-z0-9_]*=.*/, "", name)
  }
  sub(/=.*/, "", name)
  if (name ~ /^(EXCLUDED_EXPORTS)$/) {
    next
  }
  if (name ~ /^[A-Za-z_][A-Za-z0-9_]*$/) {
    print line
  }
}')
export_count=$(printf '%s\n' "$export_lines" | sed '/^$/d' | wc -l | tr -d ' ')
print "# exports $export_count"
if [[ -n "$export_lines" ]]; then
  print -r -- "$export_lines"
fi
`;

const BASH_SNAPSHOT_SCRIPT = String.raw`if [ -z "$BASH_ENV" ] && [ -r "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi
echo '# Snapshot file'
echo '# Unset all aliases to avoid conflicts with functions'
unalias -a 2>/dev/null || true
echo '# Functions'
declare -f
echo ''
bash_opts=$(set -o | awk '$2=="on"{print $1}')
bash_opt_count=$(printf '%s\n' "$bash_opts" | sed '/^$/d' | wc -l | tr -d ' ')
echo "# setopts $bash_opt_count"
if [ -n "$bash_opts" ]; then
  printf 'set -o %s\n' $bash_opts
fi
echo ''
alias_count=$(alias -p | wc -l | tr -d ' ')
echo "# aliases $alias_count"
alias -p
echo ''
export_lines=$(
  while IFS= read -r name; do
    if [[ "$name" =~ ^(EXCLUDED_EXPORTS)$ ]]; then
      continue
    fi
    if [[ ! "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      continue
    fi
    declare -xp "$name" 2>/dev/null || true
  done < <(compgen -e)
)
export_count=$(printf '%s\n' "$export_lines" | sed '/^$/d' | wc -l | tr -d ' ')
echo "# exports $export_count"
if [ -n "$export_lines" ]; then
  printf '%s\n' "$export_lines"
fi
`;

export function snapshotScriptFor(type: UserShellType): string | null {
  switch (type) {
    case "zsh":
      return ZSH_SNAPSHOT_SCRIPT.replaceAll("EXCLUDED_EXPORTS", EXCLUDED_EXPORTS);
    case "bash":
      return BASH_SNAPSHOT_SCRIPT.replaceAll("EXCLUDED_EXPORTS", EXCLUDED_EXPORTS);
    case "sh":
      return null;
  }
}

export function stripSnapshotPreamble(raw: string): string | null {
  const start = raw.indexOf(SNAPSHOT_MARKER);
  if (start < 0) return null;
  return raw.slice(start);
}

/** Interpreter for the command itself. The user's shell supplies the
 *  ENVIRONMENT (outer layer sources the snapshot / runs -l), but the command
 *  is always interpreted by bash: the model writes bash syntax, and zsh
 *  differs where it hurts (nomatch aborts unmatched globs, 1-based arrays,
 *  no word-splitting of unquoted vars). Mirrors codex, where the inner
 *  interpreter comes from the model's own argv and is bash in practice. */
const COMMAND_INTERPRETER = "/bin/bash";

export function wrapWithSnapshot(command: string, shell: UserShell, snapshotPath: string): string[] {
  const script =
    `if . '${shellSingleQuote(snapshotPath)}' >/dev/null 2>&1; then :; fi\n\n` +
    `exec '${shellSingleQuote(COMMAND_INTERPRETER)}' -c '${shellSingleQuote(command)}'`;
  return [shell.path, "-c", script];
}

/** No-snapshot fallback: a login shell supplies the environment, bash still
 *  interprets the command. */
export function wrapLoginFallback(command: string, shell: UserShell): string[] {
  return [
    shell.path,
    "-lc",
    `exec '${shellSingleQuote(COMMAND_INTERPRETER)}' -c '${shellSingleQuote(command)}'`
  ];
}

interface ShellRunResult {
  stdout: string;
  exitCode: number;
}

function runShell(
  argv: string[],
  opts: { env?: Record<string, string>; cwd?: string; timeoutMs: number }
): Promise<ShellRunResult> {
  return new Promise((resolve) => {
    const [executable = "/bin/bash", ...args] = argv;
    const child: ChildProcess = spawn(executable, args, {
      cwd: opts.cwd ?? os.homedir(),
      env: opts.env ?? process.env
    });
    // Close stdin so an rc file that reads from the terminal cannot hang the capture.
    child.stdin?.end();
    // Accumulate raw buffers and decode once at the end: per-chunk toString
    // corrupts multibyte characters split across pipe-chunk boundaries.
    const stdoutChunks: Buffer[] = [];
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(tid);
      resolve({ stdout: Buffer.concat(stdoutChunks).toString("utf8"), exitCode });
    };
    const tid = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish(-1);
    }, opts.timeoutMs);
    child.stdout?.on("data", (b: Buffer) => {
      stdoutChunks.push(b);
    });
    child.stderr?.resume();
    child.on("close", (code) => finish(code ?? -1));
    child.on("error", () => finish(-1));
  });
}

export interface CaptureShellSnapshotOptions {
  shell: UserShell;
  outPath: string;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Capture the user's login-shell environment into a sourceable snapshot file.
 * Returns the snapshot path, or null when the shell has no snapshot support,
 * the capture fails/times out, or the snapshot does not survive validation.
 */
export async function captureShellSnapshot(
  opts: CaptureShellSnapshotOptions
): Promise<string | null> {
  const script = snapshotScriptFor(opts.shell.type);
  if (!script) return null;
  const timeoutMs = opts.timeoutMs ?? SNAPSHOT_TIMEOUT_MS;
  const capture = await runShell([opts.shell.path, "-lc", script], {
    env: opts.env,
    cwd: opts.cwd,
    timeoutMs
  });
  if (capture.exitCode !== 0) return null;
  const snapshot = stripSnapshotPreamble(capture.stdout);
  if (!snapshot) return null;
  try {
    mkdirSync(path.dirname(opts.outPath), { recursive: true });
    writeFileSync(opts.outPath, snapshot, { mode: 0o600 });
  } catch {
    return null;
  }
  const validation = await runShell(
    [opts.shell.path, "-c", `set -e; . '${shellSingleQuote(opts.outPath)}'`],
    { env: opts.env, cwd: opts.cwd, timeoutMs }
  );
  if (validation.exitCode !== 0) {
    try {
      rmSync(opts.outPath, { force: true });
    } catch {
      /* ignore */
    }
    return null;
  }
  return opts.outPath;
}
