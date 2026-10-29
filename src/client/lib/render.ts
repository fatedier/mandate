type PaneLike = {
  currentCommand?: string;
  foregroundProcesses?: Array<{ command?: string }>;
};

export function getPaneDisplayCommand(pane: PaneLike | null | undefined): string {
  if (!pane) return "";
  const currentCommand = String(pane.currentCommand ?? "").trim();
  const foregroundProcesses = Array.isArray(pane.foregroundProcesses) ? pane.foregroundProcesses : [];
  const candidates = foregroundProcesses
    .map((process) => commandNameFromProcess(process.command, currentCommand))
    .filter(Boolean);
  const specific = candidates.find((candidate) => candidate !== currentCommand && !isWrapperCommand(candidate));
  return specific || candidates[0] || currentCommand;
}

function commandNameFromProcess(commandLine: unknown, currentCommand: string): string {
  const tokens = tokenizeCommandLine(commandLine);
  if (tokens.length === 0) return "";
  let index = 0;
  while (index < tokens.length && isAssignment(tokens[index])) {
    index += 1;
  }
  const executable = basename(tokens[index] ?? currentCommand);
  if (!isWrapperCommand(executable)) return normalizeCommandName(executable);

  for (let i = index + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || isAssignment(token)) continue;
    if (token.startsWith("-")) {
      if (optionTakesValue(token) && tokens[i + 1] && !(tokens[i + 1] ?? "").startsWith("-")) i += 1;
      continue;
    }
    if (isPackageManagerCommand(executable) && isPackageManagerSubcommand(token)) {
      if (token === "run" || token === "run-script") {
        const script = tokens[i + 1];
        if (script && !script.startsWith("-")) return `${normalizeCommandName(executable)}:${script}`;
      }
      continue;
    }
    if (isPythonCommand(executable) && token === "-m") {
      const moduleName = tokens[i + 1];
      if (moduleName) return normalizeCommandName(basename(moduleName));
      continue;
    }
    if (isJavaCommand(executable) && token === "-jar") {
      const jarName = tokens[i + 1];
      if (jarName) return normalizeCommandName(basename(jarName));
      continue;
    }
    const name = normalizeCommandName(basename(token));
    if (name && !isWrapperCommand(name)) return name;
  }

  return normalizeCommandName(executable || currentCommand);
}

function tokenizeCommandLine(value: unknown): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(String(value ?? "")))) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

function basename(value: unknown): string {
  const stripped = String(value ?? "").replace(/^["']|["']$/g, "").replace(/^\-+/, "");
  const parts = stripped.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || stripped;
}

function normalizeCommandName(value: unknown): string {
  let name = String(value ?? "").trim();
  if (!name) return "";
  name = name.replace(/\.(cmd|exe)$/i, "");
  if (name.startsWith("@")) {
    return name.split("/").pop()?.replace(/@[^@/]+$/, "") ?? "";
  }
  return name.replace(/@[^@/]+$/, "");
}

function isWrapperCommand(command: unknown): boolean {
  const name = normalizeCommandName(command);
  return name === "env"
    || name === "node"
    || name === "npm"
    || name === "npx"
    || name === "pnpm"
    || name === "pnpx"
    || name === "yarn"
    || name === "bun"
    || name === "deno"
    || name === "tsx"
    || name === "ts-node"
    || name === "uv"
    || name === "uvx"
    || name === "ruby"
    || name === "bundle"
    || name === "bundler"
    || name === "perl"
    || name === "java"
    || isPythonCommand(name);
}

function isAssignment(token: unknown): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(token ?? ""));
}

function optionTakesValue(token: unknown): boolean {
  return new Set([
    "-C",
    "-c",
    "-e",
    "-I",
    "-r",
    "--config",
    "--cwd",
    "--eval",
    "--import",
    "--loader",
    "--prefix",
    "--require",
    "--require-module",
    "--script"
  ]).has(String(token ?? ""));
}

function isPackageManagerCommand(command: unknown): boolean {
  return new Set(["npm", "npx", "pnpm", "pnpx", "yarn", "bun", "deno", "uv", "uvx"]).has(normalizeCommandName(command));
}

function isPackageManagerSubcommand(token: unknown): boolean {
  return new Set([
    "dlx",
    "exec",
    "run",
    "run-script",
    "x"
  ]).has(String(token ?? ""));
}

function isPythonCommand(command: unknown): boolean {
  return /^python(\d+(\.\d+)?)?$/.test(normalizeCommandName(command));
}

function isJavaCommand(command: unknown): boolean {
  return normalizeCommandName(command) === "java";
}
