import { expect, test } from "bun:test";
import { act } from "react";
import { useTranscriptViewport } from "@/routes/window/chat/useTranscriptViewport";
import { mount } from "../helpers/mount.js";

function View({ threadId, sentAt }: { threadId: string; sentAt: string | null }) {
  const { scrollRef, onScroll, onWheel, showLatest } = useTranscriptViewport({
    threadId, itemCount: 1, hasMoreOlder: false, loadOlder: async () => {}, followPaused: false, sentAt, growthKey: ""
  });
  return (
    <div ref={scrollRef} data-slot="scroller" onScroll={onScroll} onWheel={onWheel}>
      <div data-slot="transcript-column"><div /></div>
      {showLatest && <button type="button">latest</button>}
    </div>
  );
}

// A send of the reader's own takes them to the end, from wherever they were
// reading; nothing else this page sent does: a message settling into the
// transcript, or an older one still on its way.
test("only a new send takes a reader who scrolled up to the end", () => {
  const { host, rerender } = mount(<View threadId="thr_a" sentAt={null} />);
  const scroller = host.querySelector<HTMLElement>('[data-slot="scroller"]')!;
  // The test DOM has no layout: 2000px of content in a 500px view.
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 2000 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 500 });
  const readUp = () => act(() => {
    scroller.scrollTop = 400;
    scroller.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -300, bubbles: true }));
    scroller.dispatchEvent(new window.Event("scroll", { bubbles: true }));
  });
  const where = () => ({ top: scroller.scrollTop, latest: host.querySelector("button") !== null });
  readUp();
  expect(where()).toEqual({ top: 400, latest: true });
  rerender(<View threadId="thr_a" sentAt="2026-10-19T10:00:00.000Z" />);
  expect(where()).toEqual({ top: 2000, latest: false });
  // Read up again; the message settles (none on its way), then an older one is the newest left.
  readUp();
  rerender(<View threadId="thr_a" sentAt={null} />);
  rerender(<View threadId="thr_a" sentAt="2026-10-19T09:00:00.000Z" />);
  expect(where()).toEqual({ top: 400, latest: true });
  rerender(<View threadId="thr_a" sentAt="2026-10-19T10:05:00.000Z" />);
  expect(where()).toEqual({ top: 2000, latest: false });
});
