import * as fs from "node:fs";
import * as path from "node:path";
import { newRunId } from "./helpers/diagnostics.js";

/**
 * Runs the e2e suite (or the files named) with one diagnostics directory for
 * the whole run, and deletes it when every test passed.
 *
 * Diagnostics are evidence for a failure (helpers/diagnostics.ts), so a
 * passing run's are worth nothing; kept, they piled up in a directory
 * bind-mounted from the host, where full runs began failing timing-shaped
 * tests. A failing run, or one killed before it ends (a hang), keeps its
 * directory.
 */
const runId = newRunId();
// Options pass through (write them as --name=value); only paths replace e2e/.
const args = process.argv.slice(2);
const options = args.filter((arg) => arg.startsWith("-"));
const paths = args.filter((arg) => !arg.startsWith("-"));
// The slowest files start first (Bun's --timings): started as they came, the
// slowest began last and the run ended long after the rest of its work.
// --update-timings writes what this run measured, merged with what was read,
// into e2e/.artifacts (the one folder that leaves the container), to be
// copied over e2e/timings.json (`bun run test:e2e:timings` does both).
const TIMINGS = "e2e/timings.json";
const UPDATED_TIMINGS = "e2e/.artifacts/e2e-timings.json";
const timings = options.includes("--update-timings")
  ? [`--timings=${UPDATED_TIMINGS}`, `--timings=${TIMINGS}`]
  : [`--timings=${TIMINGS}`];
const proc = Bun.spawn(
  ["bun", "test", "--preload", "./tests/setup.ts", "--parallel=8", ...timings, ...options, ...(paths.length > 0 ? paths : ["e2e/"])],
  { stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, E2E_RUN_ID: runId } }
);
const code = await proc.exited;
const runDir = path.join(process.cwd(), "e2e", ".artifacts", runId);
if (code === 0) fs.rmSync(runDir, { recursive: true, force: true });
else if (fs.existsSync(runDir)) console.log(`[e2e] diagnostics kept: ${runDir}`);
process.exit(code);
