import { describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { WorkerReportCard } from "../../src/client/routes/window/chat/WorkerReportCard.js";
import { FeatureMessageLine } from "../../src/client/routes/window/chat/FeatureMessageLine.js";
import { CompressionSummaryMessage } from "../../src/client/routes/window/chat/CompressionSummaryMessage.js";
import { featureMessageReplyMetadata } from "../../src/shared/feature-message.js";
import type { AgentMessage } from "../../src/client/store/agent-chat.js";
import { mount, mountAsync } from "../helpers/mount.js";

// The transcript's rows carry no clock: a divider shows the time where the chat
// paused or a day began. The row's own time is no longer its
// title (it popped over whatever was read): the transcript shows it on hover
// (row-time.test.tsx), so the rows themselves carry none.

const AT = "2026-09-27T10:00:07.000Z";

function render(node: ReactNode) {
  return mount(<MemoryRouter>{node}</MemoryRouter>).host;
}

function expectNoTime(host: HTMLElement) {
  expect(host.querySelector("time") === null).toBe(true);
  expect(host.textContent).not.toMatch(/\d{2}:\d{2}/);
  // Nor in a title, on the row or anywhere in it.
  expect([...host.querySelectorAll("[title]")].map((el) => el.getAttribute("title")).filter((t) => /\d{2}:\d{2}/.test(t ?? ""))).toEqual([]);
}

test("a worker's report card shows no clock and holds no time of its own", () => {
  expectNoTime(render(
    <WorkerReportCard
      report={{ featureId: "f1", featureName: "project-1-release", projectId: "p1", projectName: "project-1", key: "done", line: "Plan finished." }}
    />
  ));
});

test("a worker's reply line shows no clock and holds no time of its own", () => {
  expectNoTime(render(
    <FeatureMessageLine named
      message={{
        id: "m1", threadId: "thr-1", seq: 1, role: "user", source: "feature-message", sourceThreadId: "ft", wakeId: null,
        content: { type: "text", text: "The parser stays incremental.", metadata: featureMessageReplyMetadata({ featureId: "f1", featureName: "Parser" }) },
        createdAt: AT
      }}
    />
  ));
});

describe("in a dialog", () => {
  /**
   * A time written into a dialog's text is to the minute, without this year's
   * year; the second and the year are for titles.
   */
  const VISIBLE = /^[A-Z][a-z]{2} \d{1,2}(, \d{4})? · \d{2}:\d{2}$/;
  const AT = "2026-08-02T10:04:05.000Z";

  const message = (fields: Partial<AgentMessage>): AgentMessage => ({
    id: "m1", threadId: "thr-1", seq: 1, sourceThreadId: null, wakeId: null, createdAt: AT, ...fields
  } as AgentMessage);

  async function openDialog(node: ReactNode, button: string) {
    const { host } = await mountAsync(<>{node}</>);
    const open = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(button))!;
    await act(async () => { open.click(); });
    return document.querySelector('[role="dialog"]')!;
  }

  test("a worker's reply dialog says when to the minute", async () => {
    const dialog = await openDialog(<FeatureMessageLine named={false} message={message({
      role: "user", source: "feature-message",
      content: { type: "text", text: "Paused.\nThe plan says why.", metadata: featureMessageReplyMetadata({ featureId: "f1", featureName: "Parser" }) }
    })} />, "View reply");
    const when = dialog.querySelector('[data-slot="dialog-time"]')!;
    expect(when.textContent).toMatch(VISIBLE);
  });

  test("a compaction's dialog says when to the minute", async () => {
    const dialog = await openDialog(<CompressionSummaryMessage message={message({
      role: "user", source: "compression",
      content: { type: "summary", summary: "The gist.", replacedRange: [1, 9], replacedCount: 9, retained: [] }
    })} />, "View summary");
    const when = dialog.querySelector("time")!;
    expect(when.textContent).toMatch(VISIBLE);
    expect(when.getAttribute("title")).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2}:\d{2}$/);
  });
});
