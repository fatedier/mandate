import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics, look } from "./helpers/page-diagnostics.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { everyWaitingRow } from "./helpers/home-rows";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { checkReadOnlyBash } from "../src/server/platform/shell/read-only-command.js";
import { waitUntil } from "../tests/helpers/wait.js";
import { assertStubProvider, respond, seedStubProvider } from "./helpers/responses-stub.js";

/**
 * The tool-call review through a real manager turn, the model a stub that
 * speaks the Responses stream and Decisions that same chat model, so the
 * stub also answers the review's screen and second look. The manager pushes
 * (flagged, then held with its reason, never run), lists a folder (read
 * only: the fast path lets it run unreviewed), and pushes twice more: three
 * holds in a row mark the thread as needing the user. Activity lists the
 * review's calls and the held ones. Then the fast path against bash itself:
 * for lines it lets run, the words it read for each program are the words
 * bash passes.
 */

let server: RunningServer;
const browser = browserForFile();
let stub: ReturnType<typeof Bun.serve>;
let threadId = "";
const REASON = "Pushes to the shared main branch others pull from; the user has not asked for it.";
/** What each tool call came back with, as the model read it, by call id. */
const outputs = new Map<string, string>();
const asked = { screens: [] as string[], secondLooks: 0 };
const stray: string[] = [];

/** A folder the listing reads, and a file a push would make if it ran. */
const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), "md-review-fixture-"));
fs.writeFileSync(path.join(FIXTURE, "release-notes.md"), "notes\n");
const RAN = path.join(FIXTURE, "push-ran");
const PUSH = `touch ${RAN} && git push origin main`;

/** The manager's turn: push, list, push, push, then say so. */
const STEPS = [
  { id: "push1", command: PUSH },
  { id: "ls", command: `ls ${FIXTURE}` },
  { id: "push2", command: PUSH },
  { id: "push3", command: PUSH }
];

function managerTurn(n: number, body: { input?: Array<Record<string, unknown>> }): Response {
  const items = body.input ?? [];
  for (const item of items) {
    if (item.type === "function_call_output") outputs.set(String(item.call_id), typeof item.output === "string" ? item.output : JSON.stringify(item.output));
  }
  const done = STEPS.filter((step) => outputs.has(`call_${step.id}`)).length;
  const next = STEPS[done];
  if (next) return respond(next.id, { call: { name: "bash", args: { command: next.command, description: "Push the release" } } });
  return respond(`m${n}`, { text: "The push was held back each time; it needs your word." });
}

beforeAll(async () => {
  let n = 0;
  stub = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      const body = await request.json() as { input?: Array<Record<string, unknown>> };
      const text = JSON.stringify(body);
      n += 1;
      if (text.includes("Is this call high-risk?")) {
        asked.screens.push(text.includes("git push") ? "push" : "other");
        return respond(`s${n}`, { text: text.includes("git push") ? "{\"high\": true}" : "{\"high\": false}" });
      }
      if (text.includes("You review one tool call")) {
        asked.secondLooks += 1;
        // It holds only what it was shown: the push, with the user's words
        // around it. Shown less, it lets the call run, and the marker tells.
        const shown = text.includes("git push origin main") && text.includes("tool-review: push the release");
        return respond(`r${n}`, { text: JSON.stringify(shown ? { hold: true, reason: REASON } : { hold: false, reason: "Nothing to judge." }) });
      }
      if (text.includes("tool-review: push the release")) return managerTurn(n, body);
      stray.push(text.slice(0, 300));
      return new Response(JSON.stringify({ error: { message: "unexpected request" } }), { status: 500, headers: { "content-type": "application/json" } });
    }
  });
  server = await startServer({
    configured: true,
    seed(dataDir) {
      seedStubProvider(dataDir, stub.port, (config) => {
        config.agent = {
          ...config.agent,
          decisionsEnabled: true,
          decisionsModel: { model: "openai/gpt-5.5", reasoningEffort: "provider-default" },
          toolReviewEnabled: true,
          personalAgentName: "Atlas"
        };
      });
      const store = new MandateStore(dataDir);
      try {
        threadId = new AgentStore(store.db).createManagerThread("Release push").id;
      } finally {
        store.db.close();
      }
    }
  });
  await assertStubProvider(server.baseUrl, stub.port);
}, 60_000);

afterAll(() => {
  server?.cleanup();
  stub?.stop(true);
  fs.rmSync(FIXTURE, { recursive: true, force: true });
});

test("with the review on, a flagged push is held with its reason and a read runs", async () => {
  const sent = await fetch(`${server.baseUrl}/api/agents/threads/${threadId}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "tool-review: push the release" })
  });
  expect(sent.status).toBe(202);
  await waitUntil(() => outputs.size === STEPS.length, { timeout: 60_000, label: () => `tool outputs: ${[...outputs.keys()].join(", ")}; stray: ${stray.join(" | ")}` });

  // Each push came back held, with the reason the second look wrote; the
  // listing ran, unreviewed.
  for (const id of ["push1", "push2", "push3"]) {
    expect(outputs.get(`call_${id}`)).toContain("Held back by the tool-call review; this is not a failure.");
    expect(outputs.get(`call_${id}`)).toContain(REASON);
  }
  // None of them ran; the listing did, unreviewed.
  expect(fs.existsSync(RAN)).toBe(false);
  expect(outputs.get("call_ls")).toContain("release-notes.md");
  expect(outputs.get("call_ls")).not.toContain("Held back");
  expect(asked.screens).toEqual(["push", "push", "push"]);
  expect(asked.secondLooks).toBe(3);
  expect(stray).toEqual([]);

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20_000);
  attachPageDiagnostics(page);
  try {
    // The chat shows the held call with its reason.
    await page.goto(`${server.baseUrl}/threads/${threadId}`);
    await page.getByText("The push was held back each time; it needs your word.").waitFor();
    // The four calls fold into one line; opened, a held one's row says why.
    await page.getByText("Ran 4 commands").click();
    await page.getByRole("button", { name: /Push the release/ }).first().click();
    await page.getByText(REASON).first().waitFor();
    await look(page, "held-in-chat");

    // Three holds in a row: the thread needs the user, and Home says why.
    await page.goto(`${server.baseUrl}/home`);
    await page.locator('[data-thread-title="Release push"] [role="img"][aria-label="state: needs you"]').waitFor();
    const row = (await everyWaitingRow(page)).filter({ hasText: "Release push" });
    await row.waitFor();
    expect(await row.textContent()).toContain(`Held back 3 times in a row by the tool-call review. Last: ${REASON}`);
    await look(page, "held-on-home");
  } finally {
    await page.close();
  }

  // Activity lists the review's calls, and its Held back view the three holds.
  const calls = async (query: string) => ((await (await fetch(`${server.baseUrl}/api/activity/calls?limit=100&${query}`)).json()) as { calls: Array<{ id: string; purpose: string; metadata: Record<string, unknown> | null }> }).calls;
  const reviews = await calls("purpose=tool_review");
  expect(reviews.length).toBe(6);
  const heldIds = reviews.filter((call) => call.metadata?.verdict === "held").map((call) => call.id).sort();
  expect(heldIds.length).toBe(3);
  expect((await calls("view=held")).map((call) => call.id).sort()).toEqual(heldIds);
}, 120_000);

/** Lines the fast path lets run whose words bash could read otherwise than
 *  the check does: quoting, escapes, flags with values, pipelines. */
const LINES = [
  "rg -n foo src | head -20", "sed -n '10,20p' f.ts", "find . -name '*.ts' -type f", "jq -r .a f.json",
  "git log --format=\"%h %s\" -n 3", "date '+%Y-%m-%d'", "tmux display-message -p '#S'",
  "tmux list-panes -F '#{pane_id} #{pane_current_command}'", "printf '%s\\n' x", "grep -E '^[[:space:]]+x' f",
  "rg -n 'fn\\s+foo\\(' src", "grep -n '\\bword\\b' f", "ps -eo pid,ppid,%cpu,etime=ELAPSED,args", "cat a.txt | wc -l",
  "echo \"a  b\" 'c\"d'", "git diff -U3 HEAD~1", "git show HEAD:src/a.ts", "rg -g '!*.min.js' x"
];
/** Builtins bash would run itself; disabled, it runs the stub of the name. */
const BUILTINS = ["echo", "printf", "pwd", "true", "false", "kill", "test"];

test("for lines the fast path lets run, the words it read are the words bash passes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-argv-"));
  try {
    const repo = path.join(dir, "repo");
    const stubs = path.join(dir, "stubs");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(stubs);
    const records = path.join(dir, "argv");
    const mismatches: Array<{ line: string; checker: string[]; bash: string[] }> = [];
    for (const line of LINES) {
      const read: string[][] = [];
      const verdict = await checkReadOnlyBash(line, { cwd: repo, registeredRepos: [repo], onCommand: (argv) => read.push([...argv]) });
      expect([line, verdict]).toEqual([line, { skip: true }]);
      // Each program a stub that writes the words it was given and nothing else.
      for (const [name] of read) {
        const file = path.join(stubs, name!);
        // One file per run: pipeline stages run at once and must not interleave.
        fs.writeFileSync(file, "#!/bin/sh\nfor a in \"${0##*/}\" \"$@\"; do printf '%s\\0' \"$a\"; done > \"$ARGV_LOG/$$\"\n");
        fs.chmodSync(file, 0o755);
      }
      fs.rmSync(records, { recursive: true, force: true });
      fs.mkdirSync(records);
      const run = Bun.spawnSync(["/bin/bash", "--noprofile", "--norc", "-c", `enable -n ${BUILTINS.join(" ")}\n${line}`], {
        cwd: repo, env: { PATH: stubs, ARGV_LOG: records }, stdout: "pipe", stderr: "pipe"
      });
      expect([line, run.exitCode, run.stderr.toString()]).toEqual([line, 0, ""]);
      const passed = fs.readdirSync(records).map((name) => fs.readFileSync(path.join(records, name), "utf8").split("\0").slice(0, -1));
      // Pipeline stages run at once: compare as sets of commands.
      const key = (argv: string[]) => JSON.stringify(argv);
      if (JSON.stringify(read.map(key).sort()) !== JSON.stringify(passed.map(key).sort())) {
        mismatches.push({ line, checker: read.map(key), bash: passed.map(key) });
      }
    }
    expect(mismatches).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
