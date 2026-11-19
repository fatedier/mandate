#!/usr/bin/env bun
/**
 * `bun run test:e2e [files] [--options]`: the Docker E2E suite, or the files
 * named, in a Compose project of its own; afterwards the project's container,
 * network and image are removed. With Compose's default project name every
 * checkout built and ran one image tag, so a run started in one worktree could
 * test the build another had just made. Docker's build cache is shared either
 * way, so a fresh project builds no slower.
 */
import { createHash, randomBytes } from "node:crypto";
import * as path from "node:path";

export interface E2eRunDeps {
  /** The checkout whose code is built and tested. */
  checkoutDir: string;
  /** Tells two runs in one checkout apart. */
  runId: string;
  /** Runs a command in the checkout, its output to this terminal; resolves its exit code. */
  run(command: string[]): Promise<number>;
}

/** The checkout (resolved, so one checkout named two ways is one) and the run. */
export function e2eProjectName(checkoutDir: string, runId: string): string {
  const checkout = createHash("sha256").update(path.resolve(checkoutDir)).digest("hex").slice(0, 10);
  return `mandate-e2e-${checkout}-${runId.toLowerCase()}`;
}

export async function runE2eInDocker(args: string[], deps: E2eRunDeps): Promise<number> {
  const compose = ["docker", "compose", "-p", e2eProjectName(deps.checkoutDir, deps.runId), "-f", path.join(deps.checkoutDir, "e2e", "docker-compose.yml")];
  let code: number;
  try {
    code = await deps.run([...compose, "run", "--rm", "--build", "tests", "bun", "e2e/run.ts", ...args]);
  } finally {
    // `local`: only the image this project built, which has no tag of its own.
    const removed = await deps.run([...compose, "down", "--rmi", "local", "--remove-orphans"]);
    if (removed !== 0) console.error(`[e2e] could not remove Compose project ${compose[3]}: remove it with \`${[...compose, "down", "--rmi", "local"].join(" ")}\``);
  }
  return code;
}

if (import.meta.main) {
  const checkoutDir = path.resolve(import.meta.dir, "..");
  let child: ReturnType<typeof Bun.spawn> | null = null;
  // Ctrl-C reaches the run through the terminal; this process stays to clean up.
  // A signal sent to it alone is passed on.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => { if (signal === "SIGTERM") child?.kill(signal); });
  }
  const code = await runE2eInDocker(process.argv.slice(2), {
    checkoutDir,
    runId: randomBytes(3).toString("hex"),
    run: async (command) => {
      child = Bun.spawn(command, { cwd: checkoutDir, stdio: ["inherit", "inherit", "inherit"] });
      const exit = await child.exited;
      child = null;
      return exit;
    }
  });
  process.exit(code);
}
