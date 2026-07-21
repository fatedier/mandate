import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Activity } from "lucide-react";
import { ChatProvenanceLine } from "../src/client/routes/window/chat/ChatProvenanceLine.js";
import {
  classTokens,
  hidingUtilities,
  widthVariantOffenders
} from "./container-variant-guard.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROVENANCE = {
  label: "HEARTBEAT",
  source: "work-item",
  detail: "auto · 30m · checked active items",
  title: "wake reason: work-item-heartbeat",
  createdAt: "2026-08-02T10:04:00.000Z",
  icon: Activity
};

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(<ChatProvenanceLine provenance={PROVENANCE as never} />); });
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

test("the source chip is hidden when narrow and restored when wide", () => {
  // happy-dom evaluates no container queries — this pins the tokens; the
  // widths themselves are checked in a browser.
  //
  // Written the inverted way round: the wide chip is every class carrying NO
  // variant, unchanged from before this work, and the narrow behaviour is the
  // single `@max-[34rem]:hidden` layered under it. So "restored when wide" is
  // the ABSENCE of an unprefixed `hidden` — a plain `hidden` would mean the
  // chip was deleted outright rather than dropped only when narrow.
  const view = mount();
  try {
    const chip = view.host.querySelector('[data-slot="provenance-source"]')!;
    const t = classTokens(chip);
    expect(t).toContain("@max-[34rem]:hidden");
    expect(t).not.toContain("hidden");
    // wide, unchanged from before this work
    expect(t).toContain("shrink-0");
    expect(t).toContain("font-mono");
  } finally {
    view.unmount();
  }
});

test("the label and the detail are visible at every width", () => {
  // The POSITIVE half of the guard, and the reason it exists: asserting that
  // nothing forbidden appears proves nothing about what must remain. Both of
  // the changes below revert this task while passing every other test here —
  // `@max-[34rem]:hidden` on the detail span is a well-formed narrow variant
  // that the offender walk permits, and `@max-[34rem]:sr-only` on the label
  // passes any assertion that merely compares two token identities while
  // collapsing HEARTBEAT and WORK ITEM back into the same row.
  //
  // The label must stay because five icons carry eleven labels (`Activity`
  // serves HEARTBEAT / FEATURE / WORK ITEM, `Bell` serves ALARM / WATCH). The
  // detail must stay because it is the only part that varies, and after this
  // change it is the ONLY thing separating CONTEXT/`runtime_context` from
  // CONTEXT/`compression`.
  const view = mount();
  try {
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
    expect(label.textContent).toContain("HEARTBEAT");
    expect(detail.textContent).toContain("checked active items");
    // the detail may YIELD space, which is not the same as disappearing
    expect(classTokens(detail)).toContain("truncate");
  } finally {
    view.unmount();
  }
});

test("the row's title carries the wake reason", () => {
  // Named for what it checks. It does NOT establish that the dropped source is
  // recoverable from the title: this fixture is one of the rows where the chip
  // text and the title happen to coincide, and for 5 of the 11 rows they do
  // not (ALARM's chip reads `[scheduled]` while its title says "alarm"; WATCH,
  // ANALYZER, SIDE and WORK ITEM likewise). What recovers the source is label
  // plus detail together, which is what the test above pins.
  const view = mount();
  try {
    const row = view.host.firstElementChild as HTMLElement;
    expect(row.getAttribute("title")).toContain("work-item-heartbeat");
  } finally {
    view.unmount();
  }
});

test("the provenance clock is a fixed-width semantic time", () => {
  const view = mount();
  try {
    const time = view.host.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe(PROVENANCE.createdAt);
    expect(time?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(time?.textContent).not.toMatch(/AM|PM/);
  } finally {
    view.unmount();
  }
});

test("no width variant other than the narrow one reaches the provenance line", () => {
  // Same property the tool row is guarded by, sharing one implementation: the
  // only width decision this row may make is `@max-[34rem]:`. Anything else
  // means something is being layered ON TOP of the wide layout again, which is
  // the shape of bug that broke wide twice on the tool row.
  const view = mount();
  try {
    const all = [...view.host.querySelectorAll("*")];
    const tokens = all.flatMap((el) => classTokens(el));
    expect(widthVariantOffenders(tokens)).toEqual([]);
    // guard the guard: the walk must actually be reaching the narrow token
    expect(tokens).toContain("@max-[34rem]:hidden");
    // and neither the sanctioned variant nor the utility that establishes the
    // context may itself read as an offender
    expect(widthVariantOffenders(["@container", "@max-[34rem]:hidden"])).toEqual([]);
  } finally {
    view.unmount();
  }
});
