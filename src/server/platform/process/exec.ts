import { execFile } from "node:child_process";
import type { ExecFileException, ExecFileOptions } from "node:child_process";
import type { CommandRunner } from "./command-runner.js";

export function execFileText(
  command: string,
  args: string[],
  options: ExecFileOptions = {},
  runner?: CommandRunner
): Promise<string> {
  if (runner) {
    const result = runner.run(command, args, {
      cwd: typeof options.cwd === "string" ? options.cwd : undefined,
      env: options.env,
      maxBuffer: options.maxBuffer,
      timeout: options.timeout
    });
    if (result.status !== 0 || result.error) {
      const error = new Error(result.stderr || result.stdout || result.error?.message || `${command} failed`) as ExecFileException;
      error.stderr = result.stderr;
      error.stdout = result.stdout;
      return Promise.reject(error);
    }
    return Promise.resolve(result.stdout);
  }

  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 20 * 1024 * 1024, ...options }, (error: ExecFileException | null, stdout, stderr) => {
      if (error) {
        error.stderr = bufferToString(stderr);
        error.stdout = bufferToString(stdout);
        reject(error);
        return;
      }
      resolve(bufferToString(stdout));
    });
  });
}

function bufferToString(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString("utf8");
}
