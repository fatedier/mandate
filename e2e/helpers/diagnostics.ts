import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Evidence for a failing e2e run.
 *
 * A test here fails inside a container that is thrown away the moment the run
 * ends, driving a compiled binary whose output was piped nowhere and a browser
 * whose console nobody read. What reached the reporter was the assertion — a
 * missing element, a short list — and never the reason, which is usually one
 * layer down: the server logged an error, a request 500'd, the page threw
 * before it rendered.
 *
 * So everything is captured unconditionally rather than on failure. There is no
 * hook to capture on: bun's `afterEach` is not told whether its test passed, so
 * a run that only kept evidence for failures would keep none. Text logs are
 * cheap and a frame is tens of kilobytes; a whole run is a few megabytes, in a
 * directory the compose file mounts back out to the host so it survives the
 * container.
 */

const ROOT = path.join(process.cwd(), "e2e", ".artifacts");

/** One directory per run, so a re-run does not overwrite the evidence from the
 *  failure you are trying to read. */
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = path.join(ROOT, RUN_ID);

let announced = false;

function ensureRunDir(): string {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  if (!announced) {
    announced = true;
    // Printed once, at the top of the run, because a reader who needs this has
    // a failing suite in front of them and should not have to find out where
    // the evidence went.
    console.log(`[e2e] diagnostics: ${RUN_DIR}`);
  }
  return RUN_DIR;
}

/** Names the artifact group after the test file that asked for it, so the
 *  reporter's "(fail) e2e/ui.test.ts" points straight at a directory. */
export function callerLabel(fallback = "unlabelled"): string {
  const stack = new Error().stack ?? "";
  for (const line of stack.split("\n").slice(1)) {
    const match = line.match(/([\w.-]+)\.test\.ts/);
    if (match) return match[1]!;
  }
  return fallback;
}

export function artifactDir(label: string): string {
  const dir = path.join(ensureRunDir(), label);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Buffers a timestamped line, written out in one syscall per flush.
 *
 * Timestamps are what let a browser log and a server log be read against each
 * other, which is where most causes show up. The buffering is not premature:
 * this directory is a bind mount, so on a macOS host every write crosses the
 * VM boundary, and appending per console message once cost enough to push ten
 * five-second tests past their timeout.
 */
const pending = new Map<string, string[]>();

export function appendLine(file: string, line: string): void {
  const lines = pending.get(file);
  const entry = `${new Date().toISOString()} ${line}\n`;
  if (lines) lines.push(entry);
  else pending.set(file, [entry]);
}

export function flush(file?: string): void {
  const files = file ? [file] : [...pending.keys()];
  for (const target of files) {
    const lines = pending.get(target);
    if (!lines || lines.length === 0) continue;
    pending.delete(target);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, lines.join(""));
    } catch { /* diagnostics must never be the reason a test fails */ }
  }
}

// A suite that dies mid-run still leaves what it had recorded, which is the run
// most likely to be worth reading.
process.on("exit", () => flush());

export function writeJson(file: string, value: unknown): void {
  try {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  } catch { /* as above */ }
}

/** The tail of a captured log, for an error message that has to stand alone —
 *  a startup failure aborts the file before anyone reads the artifacts. */
export function tail(file: string, maxChars = 2000): string {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
  } catch {
    return "(no output captured)";
  }
}
