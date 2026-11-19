import { expect, test } from "bun:test";
import type { ReplyTabDto } from "../../src/shared/api-contracts.js";
import { ReplyTabView } from "../../src/client/routes/reply-tabs/ReplyTabView.js";
import { replyTabLabel } from "../../src/client/routes/reply-tabs/reply-tab-label.js";
import { formatClockMinutes } from "../../src/client/lib/format.js";
import { onCleanup } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";

// A reply opened in the panel draws from the copy its tab keeps, so it shows
// whether or not the chat has the message loaded; its tab is named by the
// reply's first line.

const tab: ReplyTabDto = {
  id: "rtab_1", threadId: "thr_1", messageId: "msg_1",
  text: "**Release check**: two of three albums are ready.\n\n| Album | State |\n|---|---|\n| garden | waits on its photo import |",
  repliedAt: "2026-10-29T12:34:00.000Z", createdAt: "2026-10-29T12:40:00.000Z"
};

test("a reply tab draws from its own text with no chat loaded", () => {
  const m = mount(<ReplyTabView tab={tab} />);
  const view = m.host.querySelector('[data-slot="reply-tab-view"]')!;
  expect(view.querySelector("h2")!.textContent).toBe("Reply");
  expect(view.querySelector("time")!.textContent).toBe(`· ${formatClockMinutes(tab.repliedAt)}`);
  expect(view.querySelector("strong")!.textContent).toBe("Release check");
  expect(view.querySelector("td")?.textContent).toBe("garden");
});

test("the tab is named by the reply's first line, Reply when it has none", () => {
  expect(replyTabLabel(tab.text)).toBe("Release check: two of three albums are ready.");
  expect(replyTabLabel("## Photo import\nDone in 20 minutes.")).toBe("Photo import");
  expect(replyTabLabel("---\n")).toBe("Reply");
});

// The name is a tab's tooltip and its Close button's label too: a first line
// that is a whole paragraph is cut, as the tab itself cuts it on screen.
test("a long first line is cut to at most 80 characters, with an ellipsis", () => {
  const long = `${"The photo import finished without errors and ".repeat(4)}then the checks ran.`;
  const label = replyTabLabel(`${long}\n\nMore below.`);
  expect([label.length <= 80, label.length >= 70, label.endsWith("…"), long.startsWith(label.slice(0, -1))]).toEqual([true, true, true, true]);
  expect(replyTabLabel("Short first line.")).toBe("Short first line.");
});

test("a name is cut between whole characters: an emoji or an accented letter at the cut is not split", () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const emoji = replyTabLabel(`${"x".repeat(78)}😀 done and more words after it`);
  expect([lone.test(emoji), emoji.endsWith("…"), emoji.length <= 80]).toEqual([false, true, true]);
  // e followed by a combining acute accent: kept together or left out together.
  const accent = replyTabLabel(`${"y".repeat(78)}e\u0301 and more words after it`);
  expect([accent.endsWith("e…"), accent.length <= 80]).toEqual([false, true]);
});

// A tab's name is read once from its reply: the panel redraws on every bit of
// thread activity, and a long reply's markdown costs real time to parse.
test("a panel that redraws reads each reply tab's name once, not on every render", async () => {
  const { spyOn } = await import("bun:test");
  const markdown = await import("../../src/client/lib/markdown-text.js");
  const { usePanelReplyTabs } = await import("../../src/client/routes/reply-tabs/panel-reply-tabs.js");
  const { useReplyTabsStore } = await import("../../src/client/store/reply-tabs.js");
  const { act } = await import("react");
  useReplyTabsStore.setState({ byThread: new Map([["thr_1", [tab, { ...tab, id: "rtab_2", messageId: "msg_2" }]]]), latest: new Map([["thr_1", 1]]), applied: new Map([["thr_1", 1]]) });
  onCleanup(() => useReplyTabsStore.setState({ byThread: new Map(), latest: new Map(), applied: new Map() }));
  const parse = spyOn(markdown, "markdownToText");
  onCleanup(() => parse.mockRestore());
  let names: string[] = [];
  function Panel({ tick }: { tick: number }) {
    names = usePanelReplyTabs("thr_1", { active: "page", before: [], home: "page", gone: () => {} }).items.map((item) => `${item.label}#${tick}`);
    return null;
  }
  const m = mount(<Panel tick={0} />);
  for (const tick of [1, 2, 3]) act(() => { m.rerender(<Panel tick={tick} />); });
  expect(names).toEqual(["Release check: two of three albums are ready.#3", "Release check: two of three albums are ready.#3"]);
  expect(parse).toHaveBeenCalledTimes(2);
});
