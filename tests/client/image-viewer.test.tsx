import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { ImageLightbox, ImageViewer } from "@/components/ImageViewer";
import { UserMessage } from "@/routes/window/chat/UserMessage";
import { ToolCallDetails } from "@/routes/window/chat/ToolCallDetails";
import { runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";

/** A chat image opens in place, over the page: a new tab of a `data:` URL is
 *  one Chrome refuses to load (it stays blank until reloaded). */

afterEach(runCleanups);

const viewer = () => document.querySelector<HTMLElement>('[role="dialog"]:not([data-state="closed"])');
const isOpen = () => viewer() !== null;
const click = (el: Element | null | undefined) => act(() => { (el as HTMLElement).click(); });
const escape = () => act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });

function attachedImage() {
  const { host } = mount(
    <UserMessage
      text="see this"
      status="persisted"
      attachments={[{ type: "image", id: "a1", name: "screen.png", mediaType: "image/png", data: "AAAA", sizeBytes: 10 }]}
    />
  );
  return host.querySelector<HTMLButtonElement>('[data-slot="user-bubble"] button[data-slot="image-open"]');
}

test("an attached image opens in place, never in a new tab: the whole picture in a dialog named after it", () => {
  const thumb = attachedImage();
  // Positive control: the thumbnail is there, and opens nothing on its own.
  expect(thumb === null).toBe(false);
  expect(thumb!.getAttribute("title")).toBe("screen.png");
  expect(document.querySelectorAll('a[target="_blank"]').length).toBe(0);
  expect(isOpen()).toBe(false);

  click(thumb);
  expect(isOpen()).toBe(true);
  const picture = viewer()!.querySelector("img")!;
  expect(picture.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  expect(picture.getAttribute("alt")).toBe("screen.png");
  // The dialog is named after the image, for a screen reader.
  const titleId = viewer()!.getAttribute("aria-labelledby")!;
  expect(document.getElementById(titleId)!.textContent).toBe("screen.png");
});

test("a click on the picture keeps it open; a click beside it, ×, or Esc closes it", () => {
  const thumb = attachedImage();
  click(thumb);
  click(viewer()!.querySelector("img"));
  expect(isOpen()).toBe(true);
  // The dialog fills the window: a click on itself, not the picture, is beside it.
  click(viewer());
  expect(isOpen()).toBe(false);

  click(thumb);
  expect(isOpen()).toBe(true);
  click(viewer()!.querySelector('button[aria-label="Close"]'));
  expect(isOpen()).toBe(false);

  click(thumb);
  expect(isOpen()).toBe(true);
  escape();
  expect(isOpen()).toBe(false);
});

// happy-dom drops env(), so the safe areas can only be read as the classes
// that carry them: on an iPhone the full-screen viewer runs under the status
// bar (viewport-fit=cover), and × and the picture must stay clear of it.
test("× and the picture keep clear of the phone's safe areas", () => {
  click(attachedImage());
  const close = viewer()!.querySelector('button[aria-label="Close"]')!.className;
  expect(["safe-area-inset-top", "safe-area-inset-right"].map((inset) => close.includes(inset))).toEqual([true, true]);
  const frame = viewer()!.className;
  expect(["pt-[calc(env(safe-area-inset-top", "pb-[calc(env(safe-area-inset-bottom"].map((inset) => frame.includes(inset))).toEqual([true, true]);
});

test("an image a tool viewed opens the same way", () => {
  const data = Buffer.from("png-bytes").toString("base64");
  const { host } = mount(
    <ToolCallDetails
      row={{
        call: { toolCallId: "call-1", toolName: "view_image", args: { path: "screenshot.png" } },
        result: {
          result: {
            type: "view_image_result",
            message: "Viewed image: screenshot.png",
            image: { type: "image", id: "img-1", name: "screenshot.png", displayPath: "shots/screenshot.png", mediaType: "image/png", data, sizeBytes: 9 }
          }
        },
        isRunning: false
      }}
    />
  );
  const thumb = host.querySelector<HTMLButtonElement>('button[data-slot="image-open"]');
  expect(thumb === null).toBe(false);
  expect(thumb!.getAttribute("title")).toBe("shots/screenshot.png");
  expect(host.querySelectorAll('a[target="_blank"]').length).toBe(0);
  click(thumb);
  const picture = viewer()!.querySelector("img")!;
  expect(picture.getAttribute("src")).toBe(`data:image/png;base64,${data}`);
  expect(picture.getAttribute("alt")).toBe("shots/screenshot.png");
});

// A chat page carries each image's address, not its bytes: the transcript
// draws a thumbnail and the viewer the original, each fetched when drawn.
// One just sent, before the server has it, has its own bytes still.
test("an image with an address draws its thumbnail and opens its original; one just sent draws its own bytes", () => {
  const url = "/api/agents/messages/msg_1/images/a1";
  const { host } = mount(
    <UserMessage text="see this" status="persisted" attachments={[{ type: "image", id: "a1", name: "screen.png", mediaType: "image/png", data: "", sizeBytes: 2_000_000, url }]} />
  );
  expect(host.querySelector('[data-slot="user-bubble"] img')!.getAttribute("src")).toBe(`${url}?size=thumb`);
  click(host.querySelector('[data-slot="user-bubble"] button[data-slot="image-open"]'));
  expect(viewer()!.querySelector("img")!.getAttribute("src")).toBe(url);
  escape();
  const local = attachedImage();
  expect(local!.querySelector("img")!.getAttribute("src")).toBe("data:image/png;base64,AAAA");
});

test("an image a tool viewed, with an address, shows its thumbnail in the details and opens its original", () => {
  const url = "/api/agents/messages/msg_2/images/img-1";
  const { host } = mount(
    <ToolCallDetails
      row={{
        call: { toolCallId: "call-1", toolName: "view_image", args: { path: "screenshot.png" } },
        result: { result: { type: "view_image_result", message: "Viewed image: screenshot.png", image: { type: "image", id: "img-1", name: "screenshot.png", displayPath: "shots/screenshot.png", mediaType: "image/png", data: "", sizeBytes: 2_000_000, url } } },
        isRunning: false
      }}
    />
  );
  const thumb = host.querySelector<HTMLButtonElement>('button[data-slot="image-open"]')!;
  expect(thumb.querySelector("img")!.getAttribute("src")).toBe(`${url}?size=thumb`);
  click(thumb);
  expect(viewer()!.querySelector("img")!.getAttribute("src")).toBe(url);
});

// The picture viewer chat thumbnails open, made a component the report's
// pictures open too: over the page, the picture fitted, × / Esc / a press
// beside it close it; with paging, ‹ › and ← → step and the bottom says
// where it is.

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const named = (name: string) => document.querySelector<HTMLButtonElement>(`[role="dialog"] button[aria-label="${name}"]`);
const counter = () => document.querySelector('[data-slot="lightbox-count"]')?.textContent ?? null;
const key = (k: string) => act(() => { dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });

const PICTURES = ["a.png", "b.png", "c.png", "d.png", "e.png", "f.png", "g.png"];
const CAPTIONS = ["", "", "c Invalid input blocked", "", "", "", ""];

function Paged({ start = 2 }: { start?: number }) {
  const [index, setIndex] = useState<number | null>(start);
  return (
    <ImageLightbox
      open={index !== null}
      onOpenChange={(open) => { if (!open) setIndex(null); }}
      src={index === null ? "" : PICTURES[index]!}
      alt={index === null ? "" : CAPTIONS[index] || PICTURES[index]!}
      paging={index === null ? undefined : {
        index, count: PICTURES.length, caption: CAPTIONS[index]!,
        onStep: (delta) => setIndex((i) => ((i ?? 0) + delta + PICTURES.length) % PICTURES.length)
      }}
    />
  );
}

test("paged: the position and caption at the bottom; ‹ › and ← → step; Esc closes", () => {
  mount(<Paged />);
  expect(counter()).toBe("3 / 7 · c Invalid input blocked");
  expect(dialog()!.querySelector("img")!.getAttribute("src")).toBe("c.png");
  const before = dialog()!.querySelector("img");
  act(() => { named("Next picture")!.click(); });
  expect(counter()).toBe("4 / 7");
  // A new picture element: the old picture never shows under the new count while it loads.
  expect(dialog()!.querySelector("img") === before).toBe(false);
  key("ArrowLeft");
  key("ArrowLeft");
  expect(counter()).toBe("2 / 7");
  key("ArrowRight");
  expect(dialog()!.querySelector("img")!.getAttribute("src")).toBe("c.png");
  act(() => { named("Previous picture")!.click(); });
  act(() => { named("Previous picture")!.click(); });
  act(() => { named("Previous picture")!.click(); });
  expect(counter()).toBe("7 / 7");
  key("Escape");
  expect(dialog() === null).toBe(true);
});

test("one picture: no arrows and no position; × closes", () => {
  function One() {
    const [open, setOpen] = useState(true);
    return <ImageLightbox open={open} onOpenChange={setOpen} src="a.png" alt="a" />;
  }
  mount(<One />);
  expect([named("Previous picture") === null, named("Next picture") === null, counter()]).toStrictEqual([true, true, null]);
  key("ArrowRight");
  expect(dialog()!.querySelector("img")!.getAttribute("src")).toBe("a.png");
  act(() => { named("Close")!.click(); });
  expect(dialog() === null).toBe(true);
});

test("a chat thumbnail still opens its picture over the page and closes", () => {
  const { host } = mount(<ImageViewer src="shot.png" alt="shot"><img src="shot.png" alt="shot" /></ImageViewer>);
  act(() => { host.querySelector<HTMLButtonElement>('[data-slot="image-open"]')!.click(); });
  expect(dialog()!.querySelector("img")!.getAttribute("src")).toBe("shot.png");
  expect(counter()).toBeNull();
  act(() => { named("Close")!.click(); });
  expect(dialog() === null).toBe(true);
});
