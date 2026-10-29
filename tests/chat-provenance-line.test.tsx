import { expect, test } from "bun:test";
import { Activity } from "lucide-react";
import { ChatProvenanceLine } from "../src/client/routes/window/chat/ChatProvenanceLine.js";
import type { ChatProvenance } from "../src/client/routes/window/chat/chatProvenance.js";
import {
  classTokens,
  hidingUtilities,
  widthVariantOffenders
} from "./container-variant-guard.js";
import { mount } from "./helpers/mount.js";

const PROVENANCE: ChatProvenance = {
  label: "Codex review went quiet for 30s",
  detail: "Wait for the read-only review to finish",
  createdAt: "2026-08-02T10:04:00.000Z",
  icon: Activity
};

function mountLine() {
  return mount(<ChatProvenanceLine provenance={PROVENANCE} />);
}

test("the label and the detail are visible at every width", () => {
  // The POSITIVE half of the guard, and the reason it exists: asserting that
  // nothing forbidden appears proves nothing about what must remain. Both of
  // the changes below revert this behaviour while passing every other test here —
  // `@max-[34rem]:hidden` on the detail span is a well-formed narrow variant
  // that the offender walk permits, and `@max-[34rem]:sr-only` on the label
  // passes any assertion that merely compares two token identities while
  // collapsing HEARTBEAT and WORK ITEM back into the same row.
  //
  // The label must stay because it is what happened ("dev server went quiet
  // for 30s"); the icon only says which kind of thing. The detail must stay
  // because it is the note or task that says why it mattered.
  const view = mountLine();
  for (const slot of ["provenance-label", "provenance-detail"]) {
    const el = view.host.querySelector(`[data-slot="${slot}"]`);
    expect(Boolean(el)).toBe(true);
    // rendered, with its text — not an empty node that happens to exist
    expect((el!.textContent ?? "").length > 0).toBe(true);
    // and nothing hides it or zeroes it, under any variant or none
    expect(hidingUtilities(classTokens(el!))).toEqual([]);
  }
  // the two are distinct spans, so one cannot stand in for the other
  const label = view.host.querySelector('[data-slot="provenance-label"]')!;
  const detail = view.host.querySelector('[data-slot="provenance-detail"]')!;
  expect(label.textContent).toContain("Codex review went quiet for 30s");
  expect(detail.textContent).toContain("Wait for the read-only review to finish");
  // the detail may YIELD space, which is not the same as disappearing
  expect(classTokens(detail)).toContain("truncate");
});

test("the row has no title: what is behind a line opens from it, never the message the model read", () => {
  // Its time is the transcript's, shown on hover above the row.
  const view = mountLine();
  expect(view.host.querySelector("[title]") === null).toBe(true);
});

test("the provenance line shows no clock (the transcript's dividers carry the time)", () => {
  const view = mountLine();
  expect(view.host.querySelector("time") === null).toBe(true);
  expect(view.host.textContent).not.toMatch(/\d{2}:\d{2}/);
});

test("no width variant other than the narrow one reaches the provenance line", () => {
  // Same property the tool row is guarded by, sharing one implementation: the
  // only width decision this row may make is `@max-[34rem]:`. Anything else
  // means something is being layered ON TOP of the wide layout again, which is
  // the shape of bug that broke wide twice on the tool row.
  const view = mountLine();
  const all = [...view.host.querySelectorAll("*")];
  const tokens = all.flatMap((el) => classTokens(el));
  expect(widthVariantOffenders(tokens)).toEqual([]);
  // The `[source]` chip is gone at every width, not hidden at one of them.
  expect(view.host.querySelector('[data-slot="provenance-source"]') === null).toBe(true);
});
