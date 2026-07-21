import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";

export type CommandRunOptions = Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> & {
  encoding?: BufferEncoding;
};

export interface CommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: CommandRunOptions): CommandResult;
}

export const nodeCommandRunner: CommandRunner = {
  run(command, args, options = {}) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      ...options
    });
    return {
      status: result.status,
      signal: result.signal,
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || ""),
      error: result.error
    };
  }
};

export function commandFailureMessage(result: CommandResult, fallback: string): string {
  return result.stderr.trim() || result.stdout.trim() || result.error?.message || fallback;
}

