import { afterEach, expect, test } from "bun:test";
import { resetCanvasTitles, useCanvasTitles } from "@/store/canvas-titles";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { settle, settleUntil } from "../helpers/mount.js";

const ID = "cnv_RelNotes001";
const titleOf = () => useCanvasTitles.getState().titles.get(ID)?.title;
const answer = (title: string) => jsonResponse({ canvases: [{ id: ID, title, kind: "report" }] });

afterEach(async () => {
  await runCleanups();
  resetCanvasTitles();
});

// A canvas changed twice in a row: its title is read twice, and the second
// read can answer first. The title kept is the latest read's.
test("a title read again keeps the latest read's answer, whichever answers first", async () => {
  let slow: (response: Response) => void = () => {};
  const calls = mockFetch((_call, index) => {
    if (index === 0) return answer("Release notes");
    if (index === 1) return new Promise<Response>((resolve) => { slow = resolve; });
    return answer("Release notes v3");
  });
  useCanvasTitles.getState().want(ID);
  await settleUntil(() => titleOf() === "Release notes", "the first read");
  useCanvasTitles.getState().refresh(ID);
  await settleUntil(() => calls.length === 2, "the second read sent");
  // Until the new name comes, the old one shows.
  expect(titleOf()).toBe("Release notes");
  useCanvasTitles.getState().refresh(ID);
  await settleUntil(() => titleOf() === "Release notes v3", "the third read");
  slow(answer("Release notes v2"));
  await settle();
  expect(titleOf()).toBe("Release notes v3");
  expect(calls).toHaveLength(3);
});

// Only a title kept is read again: one never shown is left to `want`.
test("refresh of a title never kept reads nothing", async () => {
  const calls = mockFetch(() => answer("Release notes"));
  useCanvasTitles.getState().refresh(ID);
  await settle();
  expect(calls).toHaveLength(0);
  expect(useCanvasTitles.getState().titles.has(ID)).toBe(false);
});
