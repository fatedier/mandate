import { expect, test } from "bun:test";
import { declaredDesktopWidth } from "@/routes/canvas/canvas-desktop-width";

const meta = (content: string) => `<meta name="viewport" content="${content}">`;

test("a declared desktop width is read from the page's viewport meta", () => {
  expect(declaredDesktopWidth(`<title>x</title>${meta("width=1280")}<p>hi</p>`)).toBe(1280);
  expect(declaredDesktopWidth(`<META NAME="Viewport" CONTENT="initial-scale=1, width=1600">`)).toBe(1600);
  // The first meta that names a width decides.
  expect(declaredDesktopWidth(meta("initial-scale=1") + meta("width=900") + meta("width=1400"))).toBe(900);
});

test("a page that reflows declares no desktop width", () => {
  expect(declaredDesktopWidth("<title>x</title><p>hi</p>")).toBeNull();
  expect(declaredDesktopWidth(meta("width=device-width, initial-scale=1"))).toBeNull();
  expect(declaredDesktopWidth(meta("width=320"))).toBeNull();
  expect(declaredDesktopWidth(meta("width=1280px"))).toBeNull();
});

test("only a live meta counts, as the browser parses the page", () => {
  expect(declaredDesktopWidth(`<!-- ${meta("width=1280")} -->`)).toBeNull();
  expect(declaredDesktopWidth(`<script>const m = '${meta("width=1280")}';</script>`)).toBeNull();
  expect(declaredDesktopWidth(`<template>${meta("width=1280")}</template>`)).toBeNull();
  // DOMParser runs without scripting; in the viewer, <noscript> is text.
  expect(declaredDesktopWidth(`<noscript>${meta("width=1280")}</noscript>`)).toBeNull();
});
