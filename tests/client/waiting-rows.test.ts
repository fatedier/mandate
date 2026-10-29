import { expect, test } from "bun:test";
import { waitingPlaces, waitingRows, waitingSummary, type WaitingRowFacts } from "../../src/client/lib/waiting-rows.js";
import type { WaitingEntryDto } from "../../src/shared/api/thread-status.js";

const facts: WaitingRowFacts = { agentLabel: "Juno" };

const entry = (fields: Partial<WaitingEntryDto> & Pick<WaitingEntryDto, "kind" | "waiting">): WaitingEntryDto => ({
  key: `${fields.kind}:${fields.threadId ?? fields.featureId ?? "agent"}:${fields.waiting}`,
  threadId: null, threadTitle: null, featureId: null, workerName: null, text: "", place: null, ...fields
});

test("each kind of entry is a row Home can draw: who waits, where, and a way there", () => {
  const rows = waitingRows([
    entry({ kind: "thread", waiting: "failed", threadId: "t1", threadTitle: "Cache work", text: "The provider refused the request." }),
    entry({ kind: "agent", waiting: "input", text: "Send the weekly summary now?" }),
    entry({ kind: "question", waiting: "input", threadId: "t2", threadTitle: "Tag the release", text: "Tag 3.21 today?" }),
    entry({ kind: "worker", waiting: "input", threadId: "t3", threadTitle: "Docs overhaul", featureId: "docs", workerName: "docs", text: "Keep the old page?" }),
    // Where a worker with no thread lives comes with the row: nothing else is looked up.
    entry({ kind: "worker", waiting: "input", threadId: null, featureId: "loose", workerName: "loose", text: "Which branch?", place: { projectName: "project-1", projectSlug: "md-project-1", featureSlug: "loose-win" } })
  ], facts);
  expect(rows.map(({ key, waiting, title, name, text, href }) => ({ key, waiting, title, name, text, href }))).toEqual([
    { key: "thread:t1:failed", waiting: "failed", title: "Cache work", name: "manager", text: "The provider refused the request.", href: "/threads/t1" },
    { key: "agent:agent:input", waiting: "input", title: "Juno", name: "", text: "Send the weekly summary now?", href: "/agent" },
    { key: "question:t2:input", waiting: "input", title: "Tag the release", name: "manager", text: "Tag 3.21 today?", href: "/threads/t2" },
    { key: "worker:t3:input", waiting: "input", title: "Docs overhaul", name: "docs", text: "Keep the old page?", href: "/threads/t3?worker=docs" },
    { key: "worker:loose:input", waiting: "input", title: "project-1", name: "loose", text: "Which branch?", href: "/projects/md-project-1/features/loose-win" }
  ]);
});

test("a question, a decision or a result reads as plain words, not markdown; what broke or stopped stays as it was said", () => {
  const [row, ...rest] = waitingRows([
    entry({ kind: "thread", waiting: "decision", threadId: "t1", threadTitle: "Pick a plan", text: "**Two options** — see [the report](/canvas/c1)" }),
    entry({ kind: "question", waiting: "input", threadId: "t2", threadTitle: "Rollout", text: "Roll out **staged** per [Rollout plan](/canvas/c2), keeping `cache.ttl`?" }),
    entry({ kind: "thread", waiting: "failed", threadId: "t3", threadTitle: "Cache", text: "HTTP 400: `max_tokens` too large" }),
    entry({ kind: "thread", waiting: "stopped", threadId: "t4", threadTitle: "Config", text: "path must be absolute for read: _old_/config" })
  ], facts);
  expect(row).toMatchObject({ waiting: "decision", title: "Pick a plan", name: "manager", text: "Two options — see the report", href: "/threads/t1" });
  expect(rest.map(({ waiting, text }) => [waiting, text])).toEqual([
    ["input", "Roll out staged per Rollout plan, keeping cache.ttl?"],
    ["failed", "HTTP 400: `max_tokens` too large"],
    ["stopped", "path must be absolute for read: _old_/config"]
  ]);
});

test("the badges' count and colour: what needs you (a question, or what broke) is urgent; red for what broke; otherwise the accent", () => {
  const rows = waitingRows([
    entry({ kind: "agent", waiting: "input", text: "Now?" }),
    entry({ kind: "thread", waiting: "result", threadId: "t1", threadTitle: "Docs", text: "Done." })
  ], facts);
  expect(waitingSummary(rows)).toEqual({ count: 2, urgent: true, failed: false });
  // The sidebar leaves out Your agent's own question: its row shows it.
  expect(waitingSummary(rows, { withoutAgent: true })).toEqual({ count: 1, urgent: false, failed: false });
  expect(waitingSummary(waitingRows([entry({ kind: "thread", waiting: "stopped", threadId: "t2", threadTitle: "Loop", text: "x" })], facts)))
    .toEqual({ count: 1, urgent: true, failed: true });
});

test("where rows wait, each place once, with how many", () => {
  const rows = waitingRows([
    entry({ kind: "thread", waiting: "decision", threadId: "t1", threadTitle: "Docs" }),
    entry({ kind: "thread", waiting: "result", threadId: "t2", threadTitle: "Release" }),
    entry({ kind: "question", waiting: "input", threadId: "t2", threadTitle: "Release" })
  ], facts);
  expect(waitingPlaces(rows)).toBe("Docs · Release ×2");
});
