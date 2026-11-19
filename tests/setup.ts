import { afterAll, afterEach, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { markTestRunning, runCleanups } from "./helpers/cleanup.js";
import { realClock } from "./helpers/fake-clock.js";
import { resetSettingsSaveQueue } from "../src/client/routes/settings/settings-save-queue";
import { resetActivityLogCache } from "../src/client/routes/activity/useActivityData";
import { useSnapshotStore } from "../src/client/store/snapshot";
import { DEFAULT_GIT } from "../src/server/platform/git/git.js";

// A test never writes the real data dir. A unit test once reached the
// bash tool's default runner, which writes a shell snapshot into the data dir:
// with nothing set that was ~/.mandate, and the Mandate running there sources
// the file before every command. Whatever the shell that started the tests
// exported, each test file resolves the data dir to a scratch dir of its own
// (the preload runs per file), removed when the file's tests are done. A test
// that needs a particular dir sets one and puts this one back.
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandate-test-data-"));
process.env.MANDATE_DATA_DIR = testDataDir;
afterAll(() => { fs.rmSync(testDataDir, { recursive: true, force: true }); });

// A unit test never runs git: that tier uses no external binary. Code that
// asks git without its test giving it one (a project made through a route, a
// dream looking at where the work is) is answered as a folder that is no
// repository would answer, which is what those tests' scratch folders are.
// Real git, spawned from tests running side by side, now and then reported
// no exit at all and held its test past the timeout. The e2e tier, which
// shares this preload, runs the real git: its runner (e2e/run.ts) sets
// E2E_RUN_ID.
if (!process.env.E2E_RUN_ID) {
  const NOT_A_REPOSITORY = { status: 128, signal: null, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git" };
  DEFAULT_GIT.runner = { run: async () => NOT_A_REPOSITORY };
}

const window = new Window({ url: "http://localhost/" });

// happy-dom injects the JS error intrinsics onto its window through a VM
// script that does not run under bun, leaving window.SyntaxError & co.
// undefined. Its selector engine constructs `new window.SyntaxError(...)`
// eagerly on every querySelector call, so without the backfill any
// querySelector — including React mounting a native <select> — crashes.
for (const key of [
  "Error",
  "TypeError",
  "SyntaxError",
  "RangeError",
  "EvalError",
  "ReferenceError",
  "URIError",
  "AggregateError"
]) {
  const target = window as unknown as Record<string, unknown>;
  if (target[key] === undefined) {
    target[key] = (globalThis as Record<string, unknown>)[key];
  }
}

function defineGlobal(key: string, value: unknown): void {
  if (key in globalThis) {
    try {
      Object.defineProperty(globalThis, key, {
        value,
        writable: true,
        configurable: true
      });
    } catch {
      // already defined and non-configurable — skip
    }
  } else {
    (globalThis as Record<string, unknown>)[key] = value;
  }
}

// A cancelled animation rejects its finished promise; the Web Animations
// spec marks that rejection handled (no one need await it), happy-dom does
// not, so a library that cancels its animations on teardown (auto-animate)
// would leave an unhandled AbortError between tests.
{
  const animation = (window as unknown as { Animation?: { prototype: { cancel(): void; finished?: Promise<unknown> } } }).Animation;
  const cancel = animation?.prototype.cancel;
  if (animation && cancel) {
    animation.prototype.cancel = function (this: { finished?: Promise<unknown> }) {
      this.finished?.catch(() => {});
      return cancel.call(this);
    };
  }
}

// DOM classes some component libraries touch at render time (e.g. Radix
// builds a DocumentFragment and observers even while closed). Only fill the
// gaps — never shadow bun's own globals (Event & co.) that server tests use.
for (const key of [
  "DocumentFragment",
  "DOMParser",
  "FocusEvent",
  "HTMLAnchorElement",
  "HTMLButtonElement",
  "HTMLFormElement",
  "HTMLIFrameElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "InputEvent",
  "KeyboardEvent",
  "MouseEvent",
  "MutationObserver",
  "NodeFilter",
  "PointerEvent",
  "ResizeObserver",
  "SVGElement",
  "ShadowRoot",
  "WheelEvent"
]) {
  if (!(key in globalThis)) {
    (globalThis as Record<string, unknown>)[key] = (window as unknown as Record<string, unknown>)[
      key
    ];
  }
}

defineGlobal("window", window);
defineGlobal("document", window.document);
// Events dispatched onto DOM nodes must be happy-dom events, not bun's
// natives (happy-dom's dispatchEvent rejects foreign event classes). Radix
// and src/client both construct CustomEvent for DOM targets.
defineGlobal("CustomEvent", window.CustomEvent);
defineGlobal("navigator", window.navigator);
defineGlobal("HTMLElement", window.HTMLElement);
defineGlobal("Element", window.Element);
defineGlobal("Node", window.Node);
defineGlobal("getComputedStyle", window.getComputedStyle);
let animationFrameId = 0;
const animationFrameTimers = new Map<number, ReturnType<typeof setTimeout>>();
defineGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
  const id = ++animationFrameId;
  const timer = setTimeout(() => {
    animationFrameTimers.delete(id);
    cb(performance.now());
  }, 16);
  animationFrameTimers.set(id, timer);
  return id;
});
defineGlobal("cancelAnimationFrame", (id: number) => {
  const timer = animationFrameTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    animationFrameTimers.delete(id);
  }
});
defineGlobal("matchMedia", window.matchMedia.bind(window));

const realFetch = globalThis.fetch?.bind(globalThis);

defineGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  if (process.env.MANDATE_TEST_ALLOW_NETWORK === "1" && realFetch) {
    return realFetch(input, init);
  }
  throw new Error(
    `Test attempted a real network request${url ? ` to ${url}` : ""}. Mock fetch or pass an injected HTTP client instead.`
  );
});

// A worker a test starts has a fetch of its own that the refusal above does
// not reach: each one starts with a preload that refuses the network too,
// except this machine's loopback, where the tests' model stubs listen.
{
  const guard = fileURLToPath(new URL("./helpers/worker-network-guard.ts", import.meta.url));
  const BaseWorker = globalThis.Worker;
  class GuardedWorker extends BaseWorker {
    constructor(spec: string | URL, options?: WorkerOptions) {
      const preload = options?.preload === undefined ? [] : Array.isArray(options.preload) ? options.preload : [options.preload];
      super(spec, { ...options, preload: [guard, ...preload] });
    }
  }
  defineGlobal("Worker", GuardedWorker);
}

const memory = new Map<string, string>();
defineGlobal("localStorage", {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => { memory.set(k, v); },
  removeItem: (k: string) => { memory.delete(k); },
  clear: () => memory.clear(),
  key: () => null,
  length: 0
});

// Client tests render inside act (tests/helpers/mount.tsx), so React is told
// it is under test once, here, rather than by every file.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// What a test mounted or replaced is undone after it, even when it failed
// half-way (tests/helpers/cleanup.ts).
beforeEach(() => markTestRunning(true));
afterEach(runCleanups);
afterEach(() => markTestRunning(false));
// A test that faked the clock and left it so gives it back safely: see
// realClock (tests/helpers/fake-clock.ts).
afterEach(realClock);
// Settings' saves are one queue for the app: a save one test left on its way
// must not hold up, or count as saving in, the next.
afterEach(resetSettingsSaveQueue);
// The Activity log keeps its last page across a remount; one test's rows must
// not be the next one's under the same filters (after runCleanups unmounted it).
afterEach(resetActivityLogCache);
// A request the app's API helper saw fail sets the app's banner, which
// outlives the test: one file's unserved 404 read as a later file's failure.
afterEach(() => useSnapshotStore.setState({ banner: "" }));
