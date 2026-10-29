import { expect, test } from "bun:test";
import { canvasPathOf } from "@/lib/canvas-link";

// Which links in what an agent wrote point at a canvas of this app. Those
// open the canvas over the page; every other link is the browser's.
const HERE = "http://localhost:4175/threads/thr_a?worker=w1";

test("a canvas's path, alone or behind this page's own address, is this app's canvas", () => {
  expect(canvasPathOf("/canvas/cnv_1", HERE)).toBe("/canvas/cnv_1");
  expect(canvasPathOf("  /canvas/cnv_1  ", HERE)).toBe("/canvas/cnv_1");
  expect(canvasPathOf("http://localhost:4175/canvas/cnv_1", HERE)).toBe("/canvas/cnv_1");
  expect(canvasPathOf("HTTP://localhost:4175/canvas/cnv_1", HERE)).toBe("/canvas/cnv_1");
  // What follows the id is kept.
  expect(canvasPathOf("/canvas/cnv_1?page=2#notes", HERE)).toBe("/canvas/cnv_1?page=2#notes");
  expect(canvasPathOf("http://localhost:4175/canvas/cnv_1#notes", HERE)).toBe("/canvas/cnv_1#notes");
  // An id is letters, digits, "-" and "_", whatever its prefix.
  expect(canvasPathOf("/canvas/zoom-canvas", HERE)).toBe("/canvas/zoom-canvas");
  expect(canvasPathOf("/canvas/0b9c2f4e-7a1d-4c55-9e0b-3f6a8d2c1e47", HERE)).toBe("/canvas/0b9c2f4e-7a1d-4c55-9e0b-3f6a8d2c1e47");
});

test("a route's pattern or a placeholder is not an id", () => {
  // What an agent writes when it describes the route, not a canvas.
  for (const href of ["/canvas/:canvasId", "/canvas/<id>", "/canvas/{id}", "/canvas/*", "/canvas/$ID", "/canvas/...", "/canvas/cnv_1.html", "/canvas/a b", "/canvas/%3Cid%3E"])
    expect([href, canvasPathOf(href, HERE)]).toEqual([href, null]);
});

test("another host's address is that host's, whatever its path", () => {
  expect(canvasPathOf("https://example.com/canvas/cnv_1", HERE)).toBeNull();
  expect(canvasPathOf("http://localhost:4174/canvas/cnv_1", HERE)).toBeNull();
  expect(canvasPathOf("https://localhost:4175/canvas/cnv_1", HERE)).toBeNull();
  expect(canvasPathOf("//example.com/canvas/cnv_1", HERE)).toBeNull();
});

test("on the desktop app's own scheme the page's host still decides", () => {
  // Every address on such a scheme reports the origin "null": comparing
  // origins would take none of them for this app, or all of them.
  const desktop = "tauri://localhost/threads/thr_a";
  expect(canvasPathOf("/canvas/cnv_1#notes", desktop)).toBe("/canvas/cnv_1#notes");
  expect(canvasPathOf("//example.com/canvas/cnv_1", desktop)).toBeNull();
  expect(canvasPathOf("http://localhost/canvas/cnv_1", desktop)).toBeNull();
  expect(canvasPathOf("http://127.0.0.1:4175/canvas/cnv_1", desktop)).toBeNull();
});

test("an address that is not one is no page to compare with", () => {
  expect(canvasPathOf("/canvas/cnv_1", "")).toBeNull();
  expect(canvasPathOf("http://localhost:4175/canvas/cnv_1", "not an address")).toBeNull();
});

test("what is not a canvas's own page is not one", () => {
  for (const href of [
    "/canvas/cnv_1/embed", "/canvas/", "/canvas", "/canvases/cnv_1", "/threads/thr_1", "/projects/p/features/f",
    // Relative to wherever the reader is: not a path from the root.
    "canvas/cnv_1", "./canvas/cnv_1", "../canvas/cnv_1",
    "https://example.com/docs", "mailto:someone@example.com", "javascript:alert(1)", "#notes", "", "   "
  ]) expect([href, canvasPathOf(href, HERE)]).toEqual([href, null]);
  expect(canvasPathOf(undefined, HERE)).toBeNull();
  expect(canvasPathOf(null, HERE)).toBeNull();
});
