import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { FileModal, FilePage } from "@/routes/files/FilePage";
import { MarkdownView } from "@/components/MarkdownView";
import { runCleanups } from "../helpers/cleanup.js";
import { mountAsync, settle, settleUntil } from "../helpers/mount.js";

// A file opened from a page with no panel (a phone) comes up over the page
// and goes with one step back; a direct visit is the file's own page.

afterEach(() => { runCleanups(); });

let at = "";
function Where() {
  at = useLocation().pathname;
  return null;
}

test("a file link with no panel opens the file over the page; its close button goes back", async () => {
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/home"]}>
      <Routes>
        <Route path="/home" element={<MarkdownView text="[report.md](/tmp/project-1/docs/report.md#L3)" />} />
        <Route path="/file" element={<FileModal />} />
      </Routes>
      <Where />
    </MemoryRouter>
  );
  await act(async () => { host.querySelector<HTMLElement>("a[data-file-link]")!.click(); });
  await settleUntil(() => document.querySelector('[role="dialog"][aria-label="File"] [data-slot="file-view"]') !== null, "the file over the page");
  const view = document.querySelector('[role="dialog"][aria-label="File"] [data-slot="file-view"]')!;
  expect([view.getAttribute("data-path"), view.getAttribute("data-line"), view.getAttribute("data-presentation")]).toEqual(["/tmp/project-1/docs/report.md", "3", "dialog"]);
  await act(async () => { document.querySelector<HTMLElement>('[role="dialog"] button[aria-label="Close file"]')!.click(); });
  await settle();
  expect(at).toBe("/home");
});

test("a direct visit to a file's address shows the file's own page", async () => {
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/file?path=%2Ftmp%2Fa.md&line=7"]}>
      <Routes><Route path="/file" element={<FilePage />} /></Routes>
    </MemoryRouter>
  );
  const view = host.querySelector('[data-slot="file-view"]');
  expect([view?.getAttribute("data-path"), view?.getAttribute("data-line"), view?.getAttribute("data-presentation")]).toEqual(["/tmp/a.md", "7", "page"]);
});

test("a file opened from a file over the page stays over that same page", async () => {
  let background = "";
  function Behind() {
    const state = useLocation().state as { backgroundLocation?: { pathname: string } } | null;
    background = state?.backgroundLocation?.pathname ?? "";
    return null;
  }
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/home"]}>
      <Routes>
        <Route path="/home" element={<MarkdownView text="[a.md](/tmp/a.md)" />} />
        <Route path="/file" element={<MarkdownView text="[b.md](/tmp/b.md)" />} />
      </Routes>
      <Behind />
    </MemoryRouter>
  );
  await act(async () => { host.querySelector<HTMLElement>("a[data-file-link]")!.click(); });
  expect(background).toBe("/home");
  await act(async () => { host.querySelector<HTMLElement>('a[data-file-link="/tmp/b.md"]')!.click(); });
  expect(background).toBe("/home");
});
