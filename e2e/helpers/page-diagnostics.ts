import * as path from "node:path";
import type { Page } from "playwright";
import { appendLine, artifactDir, callerLabel, flush } from "./diagnostics.js";

/**
 * Records what a page did, so a failed assertion can be read against it.
 *
 * The three sources below are the ones that explain a UI failure without being
 * visible to the assertion: an uncaught exception stops the render before the
 * element exists, a 500 leaves a list empty, a failed request leaves it stale.
 * All three surface to the reporter as the same thing — a selector that never
 * matched — so the log is the only place the difference shows.
 */

/** Set MANDATE_E2E_CAPTURE_FRAMES=1 to keep a frame from every page, not only
 *  the ones that recorded an error. For a failure the log cannot explain. */
const ALWAYS_CAPTURE = process.env.MANDATE_E2E_CAPTURE_FRAMES === "1";

export interface PageDiagnostics {
  /** Writes a frame and the DOM under this name. Called on teardown, where it
   *  keeps the frame only for a page that saw an error; pass force to take one
   *  regardless, at any point a test wants the state it is about to leave. */
  capture: (reason: string, force?: boolean) => Promise<void>;
  /** Counts of what was seen, for a test that wants to assert on cleanliness. */
  errorCount: () => number;
  logFile: string;
}

let pageSeq = 0;

export function attachPageDiagnostics(page: Page, label = callerLabel()): PageDiagnostics {
  const dir = artifactDir(label);
  const name = `page-${++pageSeq}`;
  const logFile = path.join(dir, `${name}.log`);
  let errors = 0;

  page.on("console", (message) => {
    const type = message.type();
    if (type === "error") errors += 1;
    appendLine(logFile, `console.${type} ${message.text()}`);
  });

  // An uncaught exception is the single most common invisible cause: React
  // stops, the element the test waits for never arrives, and the assertion
  // reports only its own absence.
  page.on("pageerror", (error) => {
    errors += 1;
    appendLine(logFile, `pageerror ${error.message}\n${error.stack ?? ""}`);
  });

  page.on("requestfailed", (request) => {
    errors += 1;
    appendLine(logFile, `requestfailed ${request.method()} ${request.url()} — ${request.failure()?.errorText ?? "?"}`);
  });

  page.on("response", (response) => {
    if (response.status() >= 400) {
      errors += 1;
      appendLine(logFile, `http ${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });

  const capture = async (reason: string, force = false) => {
    appendLine(logFile, `capture ${reason} (url ${page.url()})`);
    flush(logFile);
    // A frame and a DOM dump are two round trips to the browser and two writes
    // to a bind-mounted directory, on every page close. Taking them
    // unconditionally cost enough under a full suite's contention to push the
    // viewport tests past their five-second budget — diagnostics that change
    // the result they are meant to explain are worse than none. So the text log
    // is always kept, and the frame is taken when this page saw something go
    // wrong, or when someone debugging asks for all of them.
    if (!force && errors === 0 && !ALWAYS_CAPTURE) return;
    try {
      await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: false });
    } catch { /* page gone */ }
    try {
      await Bun.write(path.join(dir, `${name}.html`), await page.content());
    } catch { /* page gone */ }
  };

  // Every test here closes its page in a `finally`, so taking the frame on the
  // way through `close` is what makes the capture unconditional without asking
  // each test to remember. It has to run before the close, not on the `close`
  // event, which fires when there is nothing left to photograph.
  const close = page.close.bind(page);
  page.close = async (options?: Parameters<Page["close"]>[0]) => {
    await capture("close");
    return close(options);
  };

  return { capture, errorCount: () => errors, logFile };
}
