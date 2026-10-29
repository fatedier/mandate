import { expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright";
import type { FeatureChangedFileDto, FeatureChangesResponse } from "../../src/shared/api-contracts";
import { seedThreadNotice } from "./global-notice.js";
import { seedNamedAgentWithVoice, startServer, type RunningServer } from "./server.js";
import { MandateStore } from "../../src/server/app/store.js";
import { AgentStore } from "../../src/server/modules/agent/agent-store.js";
import { FeaturesStore } from "../../src/server/modules/features/features-store.js";
import { ProjectsStore } from "../../src/server/modules/projects/projects-store.js";
import { trackRequests } from "./settle.js";

// On a touch screen every control is at least 44 by 44 CSS px to touch (WCAG
// 2.5.5) and no two controls' touch areas overlap (WCAG counts an overlap in
// neither). Controls keep their look: an invisible area (the `hit` utility)
// reaches past a small one, and list rows, which sit edge to edge, grow.
// A touch area is what the browser hits: the control's box and its ::after,
// cut by every ancestor that clips. Exempt by decision: the chat's tool-run
// lines (full width, 28px), the navigation's rows (36px),
// links inside a sentence (WCAG's inline exception), and text fields.

// The e2e/touch-targets-*.test.ts files share this: the measurement, the
// devices, the seeded server and the data more than one of them uses.

// A 1x1 PNG to attach.
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
export const emptyPlanFor = (featureId: string) => ({ featureId, goal: null, conclusion: null, openQuestions: [] as string[], steps: [], goalHistory: [], updatedAt: null });
export const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
/** A screenshot the user attached in the seeded thread: wider than any screen, so the viewer has to fit it. */
// A raster image, as an attachment always is: the chat serves no other kind.
const BUILD_SHOT = Buffer.from(await new Bun.Image(new Uint8Array(fs.readFileSync("assets/pwa/icon-512.png"))).resize(1600, 1000).png().bytes()).toString("base64");
let browser: Browser;
let server: RunningServer | undefined;
let threadId = "";
let archivedThreadId = "";

const LONG_CALLS = [
  { id: "c-read", name: "read", args: { path: "/repo/pkg/rendering/pagecaching/cache/expiry.go" }, result: "package cache\n\nfunc (c *Cache) Evict() error {\n\treturn nil\n}" },
  { id: "c-bash-fail", name: "bash", args: { command: "go test -race ./pkg/transport/...", description: "Run the transport tests under the race detector" }, result: "stdout:\n--- FAIL: TestCacheExpiryLeak (2.01s)\nFAIL\nstderr:\nexit status 1\nexitCode: 1" },
  { id: "c-grep", name: "bash", args: { command: "rg -n 'EvictHook' pkg/", description: "Find readers of EvictHook" }, result: "stdout:\n\nexitCode: 1" },
  // A tool with no view of its own: laid-out arguments and a long structured
  // result, each with JSON and Copy, the result with Expand.
  {
    id: "c-fetch", name: "web_fetch",
    args: { url: "https://github.com/acmecorp/project-1/releases", maxBytes: 20000, note: "Find the release that changed how EvictHook behaves on a stale entry, and list every tag after it that still carries the leak, newest first, with the date each one shipped." },
    result: JSON.stringify({ status: 200, title: "Releases · acmecorp/project-1", releases: Array.from({ length: 30 }, (_, i) => ({ tag: `v0.${60 - i}.0`, assets: 14 + (i % 3) })) })
  },
  // Only a piece of writing: its part starts right under the section's header.
  {
    id: "c-note", name: "take_note",
    args: { a_very_long_argument_heading_with_a_few_extra_words: "Releases after v3.14 tag from main once the race detector passes; the fork keeps its own notes and ships a day later." },
    result: "noted"
  }
];

/** Launches the browser, and with `server` the seeded Mandate server the
 *  pages are measured on (its manager thread is `threadId`). */
export async function startTouchHarness(options: { server: boolean }) {
  if (options.server) server = await startServer({
    configured: true,
    seed(dataDir) {
      // A second model, so a route can take a fallback and a provider shows two.
      const configFile = path.join(dataDir, "config.json");
      const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
      config.models.providers.openai.models.push({ id: "gpt-5.6-sol", input: ["text"], supportsReasoning: true });
      // A provider with a one-letter name: its heading's button is still 44px wide.
      config.models.providers.x = { type: "openai", apiKey: "not-a-real-key", models: [{ id: "x-1", input: ["text"], supportsReasoning: false }] };
      // The providers with a key answer from a closed local port: the list's
      // checks and Add models fail at once, inside the container, instead of
      // asking the real OpenAI with the placeholder key.
      for (const name of ["openai", "x"]) config.models.providers[name].baseURL = "http://127.0.0.1:9/v1";
      // A long id: at 320px its chip must not squeeze its ×.
      config.models.providers.openai.models.push({ id: "meta-llama/llama-4-maverick-17b-128e-instruct", input: ["text"], supportsReasoning: false });
      // Voice starts on the agent's page.
      seedNamedAgentWithVoice(config);
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
      const store = new MandateStore(dataDir);
      try {
        const agent = new AgentStore(store.db);
        const projects = new ProjectsStore(store.db);
        const features = new FeaturesStore(store.db);
        const thread = agent.createManagerThread("project-1 3.21 release");
        threadId = thread.id;
        // An earlier stretch compacted: its line offers the summary.
        agent.appendMessage({ threadId, role: "user", source: "compression", content: { type: "summary", summary: "Earlier: the evict path was traced to Stream.Close.", replacedRange: [0, 0], replacedCount: 12, retained: [] } });
        agent.appendMessage({ threadId, role: "user", source: "user", content: {
          type: "text", text: "Look at the cache expiry leak.",
          attachments: [{ type: "image", id: "img_build", name: "build-4128.png", mediaType: "image/png", data: BUILD_SHOT, sizeBytes: Buffer.from(BUILD_SHOT, "base64").length }]
        } });
        agent.appendMessage({
          threadId, role: "assistant", source: "self", wakeId: "w1",
          content: { type: "assistant", text: "Reproducing first.", toolCalls: LONG_CALLS.map((c) => ({ toolCallId: c.id, toolName: c.name, args: c.args })) }
        });
        for (const c of LONG_CALLS) {
          agent.appendMessage({ threadId, role: "tool", source: "self", wakeId: "w1", content: { type: "tool_result", toolCallId: c.id, toolName: c.name, result: c.result } });
        }
        agent.appendMessage({
          threadId, role: "assistant", source: "self", wakeId: "w1",
          content: { type: "assistant", text: "Found it. See [the report](https://github.com/acmecorp/project-1/issues/1) for details.\n\n```go\nfunc (c *Cache) Evict() error {\n\tc.sweepOnce.Do(func() { close(c.doneCh) })\n\treturn nil\n}\n```" }
        });
        // A worker's long reply: a line that opens it.
        agent.appendMessage({ threadId, role: "user", source: "feature-message", content: { type: "text", text: "Fixed the leak in Stream.Close.\nThe evict path now closes closeCh once; the race test passes 200 runs.", metadata: { featureMessage: { direction: "reply", featureName: "evicthook" } } } });
        for (let i = 0; i < 6; i++) agent.createManagerThread(`Thread ${i + 1}`);
        // An archived thread: the drawer's Archived group, and a page read-only.
        archivedThreadId = agent.createManagerThread("project-2 flaky upload").id;
        agent.appendMessage({ threadId: archivedThreadId, role: "user", source: "user", content: { type: "text", text: "Why does the upload test flake?" } });
        agent.appendMessage({ threadId: archivedThreadId, role: "assistant", source: "self", content: { type: "assistant", text: "A race on the temp dir; fixed in the harness." } });
        agent.archiveThread(archivedThreadId);
        // The global agent heard back from that thread: its card, then the
        // notice's line, whose name opens what the thread said.
        seedThreadNotice(store.db, agent, { threadId, title: "project-1 3.21 release", stop: "stopped", reply: "3.21 is ready to tag." });
        const projectId = projects.insert({ name: "project-1", workingDir: "/tmp", isGit: false, gitRemote: null, tmuxSessionName: "md-project-1-touch", ownership: "app" });
        features.insert({ projectId, name: "evicthook", mode: "shared-cwd", branch: null, worktreePath: null, tmuxWindowName: "evicthook", ownership: "app", ownerThreadId: threadId });
        // Activity: calls to break down and list.
        const call = store.db.prepare(`insert into llm_calls (id, purpose, scope_type, scope_id, provider, model, request_hash, response_hash, metadata_json, input_tokens, output_tokens, total_tokens, cache_read_tokens, status, error_json, started_at, finished_at, latency_ms, created_at, updated_at) values (?, ?, 'agent_thread', 'thread-e2e', 'openai-compatible', ?, ?, ?, '{"wakeId":"w1","step":3}', 50000, 130, 50130, 40000, 'succeeded', null, ?, ?, ?, ?, ?)`);
        const now = Date.now();
        // More than a page (20), so the log offers older calls.
        for (let i = 0; i < 24; i++) {
          const at = new Date(now - i * 3_600_000).toISOString();
          call.run(`llm_touch_${i}`, i % 2 ? "agent_wake_step" : "memory_dream", i % 3 ? "codex/gpt-5.6-sol" : "gpt-5.5", `req_${i}`, `res_${i}`, at, at, 900 + i, at, at);
        }
        // Memory: entries of every type, source and scope.
        const mem = store.db.prepare(`insert into memory_entries (id, scope, project_id, feature_id, type, source, user_quote, status, content, created_at, updated_at, metadata_json) values (?, ?, ?, null, ?, ?, ?, 'available', ?, ?, ?, null)`);
        const types = ["preference", "knowledge", "task"] as const;
        const sources = ["user", "agent", "extraction"] as const;
        for (let i = 0; i < 9; i++) {
          const at = new Date(now - i * 86_400_000).toISOString();
          const user = i % 3 === 0;
          const type = user ? "preference" : types[i % 3]!;
          mem.run(`mem_touch_${i}`, user ? "user" : "project", user ? null : projectId, type, sources[i % 3]!, sources[i % 3] === "user" ? "tag releases from main" : null, `Memory ${i}: project-1 releases are tagged from main after the full test suite passes.`, at, at);
        }
      } finally {
        store.db.close();
      }
    }
  });
  browser = await chromium.launch();
  return { browser, server, threadId, archivedThreadId };
}

export async function stopTouchHarness() {
  await browser?.close();
  server?.cleanup();
}

interface Problems { count: number; small: string[]; overlaps: string[]; shadowed: string[] }

/** Every control on the page as a finger meets it: its touch area (box plus
 *  ::before and ::after, cut by its own overflow and every ancestor that
 *  clips). Reports those under 44 by 44, any two whose areas overlap, and any
 *  a parent control's area covers (tapping it would hit the parent).
 *  Controls covered by something else at their centre (scrolled under a fixed
 *  bar) are not reachable, and not counted. */
async function touchProblems(page: Page): Promise<Problems> {
  return page.evaluate(() => {
    const CONTROL = 'button, a[href], [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], summary, select';
    const name = (el: Element) => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || el.tagName;
    const targets: Array<{ el: Element; name: string; t: number; b: number; l: number; r: number; sized: boolean }> = [];
    const shadowed: string[] = [];
    // A control is what is focusable as one, or anything else that shows a
    // pointer (a chip or a row with a click handler), outermost only: the
    // cursor is inherited.
    const pointing = (el: Element) => getComputedStyle(el).cursor === "pointer";
    const candidates = [...document.querySelectorAll<HTMLElement>(CONTROL)];
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      if (pointing(el) && !(el.parentElement && pointing(el.parentElement)) && !el.matches(CONTROL) && !el.closest(CONTROL)) candidates.push(el);
    }
    // A native checkbox or radio is tapped through its label when it has one.
    for (const box of document.querySelectorAll<HTMLElement>('input[type="checkbox"], input[type="radio"]')) {
      const target = box.closest("label") ?? box;
      if (!candidates.includes(target)) candidates.push(target);
    }
    for (const el of candidates) {
      if (!el.checkVisibility({ visibilityProperty: true }) || el.closest('[aria-hidden="true"]')) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      let t = box.top, b = box.bottom, l = box.left, r = box.right;
      // A pseudo-element's offsets are from its containing block's padding
      // box: the control's when it is positioned, else the nearest positioned
      // ancestor's (an area stretched over a table cell).
      let holder: Element = el;
      while (holder.parentElement && getComputedStyle(holder).position === "static") holder = holder.parentElement;
      const hb = holder.getBoundingClientRect(), hs = getComputedStyle(holder);
      const pad = {
        t: hb.top + parseFloat(hs.borderTopWidth), b: hb.bottom - parseFloat(hs.borderBottomWidth),
        l: hb.left + parseFloat(hs.borderLeftWidth), r: hb.right - parseFloat(hs.borderRightWidth)
      };
      // An `auto` side reads as no reach.
      const px = (v: string) => Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0;
      for (const which of ["::before", "::after"]) {
        const pseudo = getComputedStyle(el, which);
        if (pseudo.content === "none" || pseudo.position !== "absolute") continue;
        t = Math.min(t, pad.t + px(pseudo.top));
        b = Math.max(b, pad.b - px(pseudo.bottom));
        l = Math.min(l, pad.l + px(pseudo.left));
        r = Math.max(r, pad.r - px(pseudo.right));
      }
      // A control partly scrolled out of a scroller is measured when it is
      // scrolled in, not here: what is cut there is the scroll position. So is
      // one whose touch area crosses an edge the scroller can still scroll
      // past (a row at the bottom of the screen); an edge it cannot (the top
      // at rest, a row of tabs' top and bottom) clips for good. The control's
      // own overflow clips its pseudo-elements too.
      let scrolledOut = false;
      for (let a: Element | null = el; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
        // Overflow clips at the padding box, inside the border.
        const outer = a.getBoundingClientRect();
        const c = {
          top: outer.top + parseFloat(cs.borderTopWidth), bottom: outer.bottom - parseFloat(cs.borderBottomWidth),
          left: outer.left + parseFloat(cs.borderLeftWidth), right: outer.right - parseFloat(cs.borderRightWidth)
        };
        const scrolls = (o: string) => o === "auto" || o === "scroll";
        if (a !== el) {
          const outX = scrolls(cs.overflowX) && (box.left < c.left - 0.5 || box.right > c.right + 0.5
            || (l < c.left - 0.5 && a.scrollLeft > 0.5) || (r > c.right + 0.5 && a.scrollLeft + a.clientWidth < a.scrollWidth - 0.5));
          const outY = scrolls(cs.overflowY) && (box.top < c.top - 0.5 || box.bottom > c.bottom + 0.5
            || (t < c.top - 0.5 && a.scrollTop > 0.5) || (b > c.bottom + 0.5 && a.scrollTop + a.clientHeight < a.scrollHeight - 0.5));
          if (outX || outY) { scrolledOut = true; break; }
        }
        if (cs.overflowY !== "visible") { t = Math.max(t, c.top); b = Math.min(b, c.bottom); }
        if (cs.overflowX !== "visible") { l = Math.max(l, c.left); r = Math.min(r, c.right); }
      }
      if (scrolledOut || b <= t || r <= l) continue;
      // At its centre: a parent control's area on top, or another control's
      // area reaching past that control's box, is a control that cannot be
      // tapped; anything else on top (a fixed bar over a scrolled row) means
      // it is not reachable here, and not counted.
      const cx = (Math.max(box.left, 0) + Math.min(box.right, innerWidth)) / 2;
      const cy = (Math.max(box.top, 0) + Math.min(box.bottom, innerHeight)) / 2;
      if (cy >= 0 && cy < innerHeight && cx >= 0 && cx < innerWidth) {
        const top = document.elementFromPoint(cx, cy);
        if (top && !el.contains(top)) {
          const owner = top.closest(CONTROL);
          const ob = owner?.getBoundingClientRect();
          if (top.contains(el) && top.matches(CONTROL)) shadowed.push(`${name(el)} under ${name(top)}`);
          else if (owner && ob && !owner.contains(el) && (cx < ob.left || cx > ob.right || cy < ob.top || cy > ob.bottom)) {
            shadowed.push(`${name(el)} under ${name(owner)}'s touch area`);
          }
          if (!top.contains(el) || top.matches(CONTROL)) continue;
        }
      }
      // Inline: a link in a sentence, or anywhere in written prose (a chat
      // message, a plan's note), is text, sized by its line.
      const inSentence = el.tagName === "A" && (el.closest('[data-slot="markdown"], [data-slot="plan-note"]') !== null || (() => {
        const block = el.closest("p, li, td, th, blockquote");
        return block !== null && (block.textContent ?? "").trim().length > (el.textContent ?? "").trim().length;
      })());
      // Exempt from size, not from overlap: the tool-run lines, a
      // design's pan-and-zoom world, whose boards and labels scale with it and
      // whose board does what its label does, and the navigation's rows (36px:
      // space is precious in the phone drawer).
      const exempt = inSentence
        || el.closest('[data-slot="tool-run-line"], [data-slot="design-world"]') !== null
        || (el.tagName === "A" && el.closest('[data-slot="app-nav"]') !== null);
      targets.push({ el, name: name(el), t, b, l, r, sized: !exempt });
    }
    const small = targets.filter((x) => x.sized && (x.r - x.l < 43.5 || x.b - x.t < 43.5))
      .map((x) => `${x.name} ${Math.round(x.r - x.l)}x${Math.round(x.b - x.t)}`);
    // A control holding another (a tab and its close, a chip and its ×) keeps
    // 44 by 44 of its own beside the inner one's area.
    for (const p of targets) {
      for (const q of targets) {
        if (p === q || !p.el.contains(q.el) || !p.sized) continue;
        const w = p.r - p.l, h = p.b - p.t;
        const own = (h >= 43.5 && (q.l - p.l >= 43.5 || p.r - q.r >= 43.5)) || (w >= 43.5 && (q.t - p.t >= 43.5 || p.b - q.b >= 43.5));
        if (!own) small.push(`${p.name} has under 44px beside ${q.name}`);
      }
    }
    const overlaps: string[] = [];
    // A table's rows are often a click target of their own: a control's area
    // stays in its row.
    for (const x of targets) {
      const row = x.el.closest("tr")?.getBoundingClientRect();
      if (row && (x.t < row.top - 0.5 || x.b > row.bottom + 0.5)) overlaps.push(`${x.name} leaves its row`);
    }
    for (let i = 0; i < targets.length; i++) {
      for (let j = i + 1; j < targets.length; j++) {
        const p = targets[i]!, q = targets[j]!;
        if (p.el.contains(q.el) || q.el.contains(p.el)) continue;
        const w = Math.min(p.r, q.r) - Math.max(p.l, q.l), h = Math.min(p.b, q.b) - Math.max(p.t, q.t);
        if (w > 0.5 && h > 0.5) overlaps.push(`${p.name} <> ${q.name} ${Math.round(w)}x${Math.round(h)}`);
      }
    }
    return { count: targets.length, small, overlaps, shadowed };
  });
}

/** Opens a page on a phone, waits for `ready`, runs `step` (taps that open
 *  something), and returns what a finger would find. */
export async function onPhone(url: string, ready: string, step?: (page: Page) => Promise<void>, setup?: (page: Page) => Promise<void>) {
  return onDevice(PHONE, url, ready, step, setup);
}

export async function onDevice(device: BrowserContextOptions, url: string, ready: string, step?: (page: Page) => Promise<void>, setup?: (page: Page) => Promise<void>) {
  const context = await browser.newContext(device);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const requests = await trackRequests(page);
  try {
    await setup?.(page);
    await page.goto(url);
    await page.locator(ready).first().waitFor();
    await step?.(page);
    // What the page loads has arrived and stopped moving.
    await requests.idle();
    const problems = await touchProblems(page);
    return { ...problems, errors };
  } finally {
    await context.close();
  }
}

export function expectFit(where: string, shape: Problems & { errors: string[] }) {
  expect({ where, small: shape.small }).toEqual({ where, small: [] });
  expectNoCollisions(where, shape);
}

/** Touch areas neither overlap nor cover one another, whatever their size. */
export function expectNoCollisions(where: string, shape: Problems & { errors: string[] }) {
  expect({ where, some: shape.count > 0 }).toEqual({ where, some: true });
  expect({ where, overlaps: shape.overlaps }).toEqual({ where, overlaps: [] });
  expect({ where, shadowed: shape.shadowed }).toEqual({ where, shadowed: [] });
  expect({ where, errors: shape.errors }).toEqual({ where, errors: [] });
}


export const NARROW: BrowserContextOptions = { viewport: { width: 320, height: 700 }, isMobile: true, hasTouch: true };
export const TABLET: BrowserContextOptions = { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true };
const files: FeatureChangedFileDto[] = ["pkg/rendering/pagecaching/cache/expiry.go", "engine/planner.go", "README.md"].map((p, i) => ({
  path: p, oldPath: null, status: "M", additions: 3 + i, deletions: i, binary: false, uncommitted: i % 2 === 0, untracked: false
}));
export const changes: FeatureChangesResponse = { compare: "head", baseRef: "HEAD", mergeBase: "x", head: "x", files, totalAdditions: 12, totalDeletions: 3 };
