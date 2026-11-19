import { afterEach, expect, test } from "bun:test";
import { act, Activity } from "react";
import { createPortal } from "react-dom";
import { hasOpenKeyboardOverlay } from "@/lib/keyboard-targets";
import { runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";

afterEach(() => { runCleanups(); });

/** A dialog drawn over the page, as Radix draws one: in a portal on <body>. */
const dialog = () => createPortal(<div role="dialog" data-state="open">Share</div>, document.body);

// A dialog left open in a page kept while another shows (shell/KeptPage) is
// hidden with it: it must not keep Escape from the page shown.
test("an open dialog owns Escape, but not one hidden with its page", () => {
  const view = mount(<Activity mode="visible">{dialog()}</Activity>);
  expect(hasOpenKeyboardOverlay()).toBe(true);
  act(() => { view.rerender(<Activity mode="hidden">{dialog()}</Activity>); });
  expect(hasOpenKeyboardOverlay()).toBe(false);
  act(() => { view.rerender(<Activity mode="visible">{dialog()}</Activity>); });
  expect(hasOpenKeyboardOverlay()).toBe(true);
});
