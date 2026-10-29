/**
 * Teardown that runs after every test, whatever the test did: tests/setup.ts
 * runs it from a preload afterEach. Helpers register here when they acquire
 * something (a mounted root, a replaced fetch), before the acquisition can
 * throw, so a test that fails half-way still leaves nothing behind for the
 * tests after it.
 *
 * It holds no React: the preload loads it into every test file, server ones
 * included.
 *
 * A preload afterEach runs after the file's own. A file whose afterEach
 * resets stores that mounted components read calls runCleanups() first, so
 * the components are gone before their stores change under them.
 */
const pending: Array<() => void> = [];
let inTest = false;

/** Whether a test is running (the preload marks each), rather than a file's
 *  beforeAll or its top level: what those register would be undone after the
 *  first test. */
export function testRunning(): boolean {
  return inTest;
}

export function markTestRunning(running: boolean): void {
  inTest = running;
}

export function onCleanup(fn: () => void): void {
  pending.push(fn);
}

/** Runs what was registered, newest first, each once; one that throws does
 *  not stop the rest, and the first error is rethrown at the end. */
export function runCleanups(): void {
  // A flag, not the value: a cleanup may throw undefined or null.
  let failed = false;
  let failure: unknown;
  while (pending.length > 0) {
    const fn = pending.pop()!;
    try {
      fn();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  if (failed) throw failure;
}
