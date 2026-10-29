import { expect, test } from "bun:test";
import { act } from "react";
import { FeatureMessageLine } from "@/routes/window/chat/FeatureMessageLine";
import { featureMessageNoteMetadata, featureMessageReplyMetadata, type FeatureReplyOutcome } from "@shared/feature-message";
import { formatUserFacingError } from "@/lib/error-message";
import { useGlobalAgentStore } from "@/store/global-agent";
import type { AgentMessage } from "@/store/agent-chat";
import { mountAsync } from "../helpers/mount.js";

const reply = (text: string): AgentMessage => ({
  id: "m1", threadId: "thr-1", seq: 1, role: "user", source: "feature-message", sourceThreadId: "thr-w", wakeId: null,
  createdAt: "2026-08-02T10:04:05.000Z",
  content: { type: "text", text, metadata: featureMessageReplyMetadata({ featureId: "f1", featureName: "Parser" }) }
} as AgentMessage);

// One shape for every reply: one size, and View reply follows
// the summary instead of waiting at the far end of the column.
test("a short reply and a long one's summary are one size", async () => {
  const short = (await mountAsync(<FeatureMessageLine message={reply("Done.")} named={false} />)).host;
  const long = (await mountAsync(<FeatureMessageLine message={reply("Paused.\nThe plan says why.")} named={false} />)).host;
  const size = (el: Element | null) => (el?.className ?? "").split(/\s+/).filter((c) => /^text-(2xs|xs|sm|base)$/.test(c));
  expect(size(short.querySelector('[data-slot="worker-reply-body"]'))).toEqual(["text-xs"]);
  expect(size(long.querySelector('[data-slot="worker-reply-body"]'))).toEqual(["text-xs"]);
});

test("View reply sits right after the summary, with a chevron", async () => {
  const { host } = await mountAsync(<FeatureMessageLine message={reply("Paused.\nThe plan says why.")} named={false} />);
  const summary = host.querySelector('[data-slot="worker-reply-summary"]')!;
  expect(summary.className.split(/\s+/)).not.toContain("flex-1");
  const more = summary.nextElementSibling!;
  expect(more.textContent).toBe("View reply");
  expect(more.querySelector("svg") === null).toBe(false);
});

// A worker writes markdown for its manager. The one line of it shown here is
// read as text: shown raw, most replies had ** and backticks as symbols.
test("a reply's summary reads as plain text: marks go, their words stay", async () => {
  const text = "Updated **[the import guide](https://example.com/docs/import)**, examples are in `samples`, `3` files changed.\n\nReady to try.";
  const { host } = await mountAsync(<FeatureMessageLine message={reply(text)} named={false} />);
  expect(host.querySelector('[data-slot="worker-reply-summary"]')!.textContent).toBe("Updated the import guide, examples are in samples, 3 files changed.");
});

test("a reply short enough to show whole reads as plain text too", async () => {
  const { host } = await mountAsync(<FeatureMessageLine message={reply("Wrote the **full** sample data under `/tmp`.")} named={false} />);
  expect(host.querySelector('[data-slot="worker-reply-body"]')!.textContent).toBe("Wrote the full sample data under /tmp.");
  expect(host.querySelector('[data-slot="worker-reply-summary"]') === null).toBe(true);
});

test("a first line with no words in it shows as written, not as an empty row", async () => {
  const { host } = await mountAsync(<FeatureMessageLine message={reply("```\ngo test ./...\n```")} named={false} />);
  expect(host.querySelector('[data-slot="worker-reply-summary"]')!.textContent).toBe("```");
});

test("opened, the reply still renders its markdown", async () => {
  const { host } = await mountAsync(<FeatureMessageLine message={reply("Confirmed **done**.\n\nSee `main`.")} named={false} />);
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-slot="worker-reply-body"]')!.click(); });
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector("strong")!.textContent).toBe("done");
  expect(dialog.querySelector("code")!.textContent).toBe("main");
});

test("the header names the worker only when asked to", async () => {
  const named = (await mountAsync(<FeatureMessageLine message={reply("Done.")} named />)).host;
  const unnamed = (await mountAsync(<FeatureMessageLine message={reply("Done.")} named={false} />)).host;
  expect(named.querySelector('[data-slot="worker-reply"]')!.firstElementChild!.textContent).toBe("Worker repliedParser");
  expect(unnamed.querySelector('[data-slot="worker-reply"]')!.firstElementChild!.textContent).toBe("Worker replied");
});

// What the user told a worker, copied to its manager: the reply
// row's shape, its own words. The body is what the user wrote, not the text
// the manager's model reads; through the user's agent it says via whom.
const note = (said: string, by: "user" | "agent" = "user"): AgentMessage => ({
  id: "m2", threadId: "thr-1", seq: 2, role: "user", source: "feature-message", sourceThreadId: "thr-w", wakeId: null,
  createdAt: "2026-10-09T10:04:05.000Z",
  content: {
    type: "text",
    text: `The user wrote to your worker "Parser" directly; the worker has the message:\n\n${said}\n\nNo reply is needed. Take it into account when you next direct this worker.`,
    metadata: featureMessageNoteMetadata({ featureId: "f1", featureName: "Parser", by, text: said, attachments: 0 })
  }
} as AgentMessage);

test("a note of what the user told a worker reads You told the worker, with the user's own words", async () => {
  const unnamed = (await mountAsync(<FeatureMessageLine message={note("Keep the parser incremental.")} named={false} />)).host;
  const row = unnamed.querySelector('[data-slot="worker-note"]')!;
  expect(row.firstElementChild!.textContent).toBe("You told the worker");
  // The paper plane, not the reply's speech bubble.
  expect(row.firstElementChild!.querySelector("svg")!.getAttribute("class")).toContain("lucide-send");
  expect(row.querySelector('[data-slot="worker-note-body"]')!.textContent).toBe("Keep the parser incremental.");
  expect(unnamed.textContent).not.toContain("No reply is needed");
  expect(unnamed.querySelector('[data-slot="worker-reply"]') === null).toBe(true);
  const named = (await mountAsync(<FeatureMessageLine message={note("Keep the parser incremental.")} named />)).host;
  expect(named.querySelector('[data-slot="worker-note"]')!.firstElementChild!.textContent).toBe("You told the workerParser");
});

test("a note keeps the user's words as typed, marks and all", async () => {
  const said = "Use `--strict` and **do not** skip the slow cases.";
  const { host } = await mountAsync(<FeatureMessageLine message={note(said)} named={false} />);
  expect(host.querySelector('[data-slot="worker-note-body"]')!.textContent).toBe(said);
  const long = `${said}\nThen report.`;
  const longHost = (await mountAsync(<FeatureMessageLine message={note(long)} named={false} />)).host;
  expect(longHost.querySelector('[data-slot="worker-note-summary"]')!.textContent).toBe(said);
});

test("a note sent through the user's agent says via whom, by the agent's name once it has one, and follows a rename", async () => {
  const agent = (name: string, named: boolean) => ({ threadId: "thr_g", name, named, unread: false, voiceConfigured: false, lastVisibleSeq: 0 }) as never;
  act(() => useGlobalAgentStore.setState({ agent: null }));
  const { host } = await mountAsync(<FeatureMessageLine message={note("Write the counts into the report.", "agent")} named={false} />);
  const header = () => host.querySelector('[data-slot="worker-note"]')!.firstElementChild!.textContent;
  expect(header()).toBe("You told the workervia your agent");
  // The row already shown follows the agent's name.
  act(() => useGlobalAgentStore.setState({ agent: agent("Atlas", true) }));
  expect(header()).toBe("You told the workervia Atlas");
  act(() => useGlobalAgentStore.setState({ agent: agent("Friday", true) }));
  expect(header()).toBe("You told the workervia Friday");
  act(() => useGlobalAgentStore.setState({ agent: null }));
});

test("a long note shows its first line and View message, which opens all of it", async () => {
  const said = "Write the counts into the report.\nMark which change between two runs.";
  const { host } = await mountAsync(<FeatureMessageLine message={note(said)} named={false} />);
  const summary = host.querySelector('[data-slot="worker-note-summary"]')!;
  expect(summary.textContent).toBe("Write the counts into the report.");
  expect(summary.nextElementSibling!.textContent).toBe("View message");
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-slot="worker-note-body"]')!.click(); });
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Write the counts into the report.");
  expect(dialog.textContent).toContain("Mark which change between two runs.");
  expect(dialog.textContent).toContain("What you told the worker.");
  // The user's words, not the text the manager's model reads.
  expect(dialog.textContent).not.toContain("No reply is needed");
  expect(dialog.textContent).not.toContain("directly; the worker has the message");
});

// A turn that ended with no words for its manager (it failed, was stopped,
// ran out of steps or budget) was drawn as "Worker replied" over the server's
// sentence. The label now says what happened and the line under it
// is the reason alone; the sentence is for the manager's model.
const ended = (outcome: FeatureReplyOutcome, detail?: string, text = "The worker's turn failed: boom"): AgentMessage => ({
  ...reply(text),
  content: { type: "text", text, metadata: featureMessageReplyMetadata({ featureId: "f1", featureName: "Parser", outcome, detail }) }
} as AgentMessage);
const AUTH = "Model provider authentication failed. Check the provider login or API key.";

for (const row of [
  { outcome: "error" as const, detail: AUTH, label: "Worker failed", reason: AUTH, icon: "lucide-circle-alert" },
  { outcome: "error" as const, detail: undefined, label: "Worker failed", reason: "Its turn ended in an error.", icon: "lucide-circle-alert" },
  { outcome: "canceled" as const, detail: undefined, label: "Worker interrupted", reason: "Its turn was interrupted before it replied.", icon: "lucide-circle-stop" },
  { outcome: "stuck" as const, detail: "read failed 5 times in a row: ENOENT", label: "Worker stopped", reason: "read failed 5 times in a row: ENOENT", icon: "lucide-circle-stop" },
  { outcome: "stuck" as const, detail: undefined, label: "Worker stopped", reason: "The same call kept failing.", icon: "lucide-circle-stop" },
  { outcome: "no_reply" as const, detail: undefined, label: "Worker finished", reason: "Its turn ended without a text reply.", icon: "lucide-message-square" }
]) {
  test(`a turn that ended ${row.outcome}${row.detail ? "" : " (no reason given)"} reads "${row.label}" over the reason alone`, async () => {
    const { host } = await mountAsync(<FeatureMessageLine message={ended(row.outcome, row.detail)} named />);
    const line = host.querySelector('[data-slot="worker-reply"]')!;
    expect(line.getAttribute("data-outcome")).toBe(row.outcome);
    expect(line.firstElementChild!.textContent).toBe(`${row.label}Parser`);
    expect(host.querySelector('[data-slot="worker-reply-body"]')!.textContent).toBe(row.reason);
    expect(line.querySelector("svg")!.getAttribute("class")!.split(/\s+/)).toContain(row.icon);
    // The transcript's ordinary colours: the red is the failed turn's and the worker's card's.
    expect(host.innerHTML).not.toContain("text-red");
    expect(host.textContent).not.toContain("Worker replied");
    expect(host.textContent).not.toContain("The worker's turn failed");
  });
}

test("a long reason is shown whole in the row: it is no reply to open", async () => {
  // Past what a reply shows in place (100), within what a failure's line shows at all (180).
  const long = `Type validation failed: ${"the provider answered with a shape nobody expected; ".repeat(2)}at step 4.`;
  expect(long.length).toBeGreaterThan(100);
  expect(long.length).toBeLessThan(180);
  const { host } = await mountAsync(<FeatureMessageLine message={ended("error", long)} named={false} />);
  const body = host.querySelector('[data-slot="worker-reply-body"]')!;
  expect(body.textContent).toBe(long);
  expect(body.tagName).toBe("DIV");
  expect(body.className.split(/\s+/)).not.toContain("truncate");
  // A reason can be one unbroken run (a path, a URL): it breaks, the column does not widen.
  expect(body.className.split(/\s+/)).toContain("break-words");
  expect(host.querySelector('[data-slot="worker-reply-summary"]') === null).toBe(true);
  expect(host.textContent).not.toContain("View reply");
});

test("a failure's reason is read as the turn's own failed line reads it", async () => {
  // The provider's error as stored; the transcript's Failed row shows its message.
  const raw = JSON.stringify({ error: { message: "The model is overloaded." } });
  const { host } = await mountAsync(<FeatureMessageLine message={ended("error", raw)} named={false} />);
  expect(host.querySelector('[data-slot="worker-reply-body"]')!.textContent).toBe(formatUserFacingError(raw));
  expect(formatUserFacingError(raw)).toBe("The model is overloaded.");
});

test("a reason is not markdown: its marks are part of what went wrong", async () => {
  const reason = "Invalid schema for function `monitor`: **strict** is not allowed with *optional* keys";
  const { host } = await mountAsync(<FeatureMessageLine message={ended("stuck", reason)} named={false} />);
  expect(host.querySelector('[data-slot="worker-reply-body"]')!.textContent).toBe(reason);
});

test("a reply with words, and every reply stored before endings were, reads Worker replied", async () => {
  const { host } = await mountAsync(<FeatureMessageLine message={reply("Feature conversation failed: boom")} named={false} />);
  const line = host.querySelector('[data-slot="worker-reply"]')!;
  expect(line.firstElementChild!.textContent).toBe("Worker replied");
  expect(line.hasAttribute("data-outcome")).toBe(false);
  expect(host.querySelector('[data-slot="worker-reply-body"]')!.textContent).toBe("Feature conversation failed: boom");
  expect(line.querySelector("svg")!.getAttribute("class")!.split(/\s+/)).toContain("lucide-message-square");
});
