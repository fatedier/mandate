import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ToolCallCard, type ToolResultSpec } from "../src/client/routes/window/chat/ToolCallCard.js";
import {
  classTokens,
  hidingUtilities,
  widthVariantOffenders
} from "./container-variant-guard.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CALL = {
  toolCallId: "tc1",
  toolName: "memory_recall_by_description",
  args: { description: "how the pill rule works", limit: 8 }
};

// `call` is optional so every existing caller keeps rendering exactly the
// CALL constant it always did; only the tests that care about a specific
// argument shape pass one.
interface MountOptions {
  expanded?: boolean;
  call?: { toolCallId: string; toolName: string; args: unknown };
  /** A whole result spec rather than a "give me any result" shorthand: the rows
   *  below read a value back OUT of the result, and the timing rows turn on the
   *  exact `createdAt`, so a default fixture would decide the case under test. */
  result?: ToolResultSpec | null;
  isRunning?: boolean;
  /** `null` is "the caller could not derive a start", which is a case the card
   *  has to handle; `undefined` would silently fall back to the default here. */
  startedAt?: string | null;
}

function mount({
  expanded = false,
  call = CALL,
  result = null,
  isRunning = false,
  startedAt = "2026-08-02T10:04:00.000Z"
}: MountOptions = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <ToolCallCard
        call={call as never}
        result={result}
        isRunning={isRunning}
        startedAt={startedAt ?? undefined}
        {...(expanded ? { expanded: true } : {})}
      />
    );
  });
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

const tokens = classTokens;

test("the tool header keeps the existing wide classes and adds the narrow layout", () => {
  // The wide row is every class that carries NO variant — it must stay exactly
  // what it has always been. The narrow layout is added under `@max-[34rem]:`.
  // happy-dom evaluates no container queries, so this pins tokens only; the
  // layout itself is verified in a browser at several widths.
  const view = mount();
  try {
    const header = view.host.querySelector("button")!;
    const t = tokens(header);
    // wide, unchanged from before this work
    expect(t).toContain("flex");
    expect(t).toContain("items-center");
    expect(t).toContain("gap-2");
    // narrow: a wrapping row, so the args span can take its own line
    expect(t).toContain("@max-[34rem]:flex-wrap");
    expect(t).toContain("@max-[34rem]:gap-y-0.5");

    const args = view.host.querySelector('[data-slot="tool-args"]')!;
    const at = tokens(args);
    // wide, unchanged
    expect(at).toContain("flex-1");
    expect(at).toContain("truncate");
    // narrow
    expect(at).toContain("@max-[34rem]:order-2");   // after the duration
    expect(at).toContain("@max-[34rem]:w-full");    // which is what forces the wrap
    expect(at).toContain("@max-[34rem]:flex-none"); // auto basis, so w-full is the hypothetical size
    expect(at).toContain("@max-[34rem]:pl-11");     // aligned under the tool name
  } finally {
    view.unmount();
  }
});

test("the tool name may truncate when narrow but never when wide", () => {
  // A wide row must still be able to WRAP a long tool name inside its own span.
  // A plain `truncate` here forbids that, and since the row cannot wrap either,
  // a ~60-char MCP name then pushed the trailing metadata outside the card and
  // into the scroller's `overflow-x-hidden`, i.e. out of sight. So truncate is
  // narrow-only.
  // `flex-1` is what makes truncate work at all when narrow: flex breaks lines on
  // max-content sizes before it shrinks anything, so with an auto basis the name
  // pushes the trailing metadata onto its own line and truncate never runs.
  const view = mount();
  try {
    const name = view.host.querySelector('[data-slot="tool-name"]')!;
    const t = tokens(name);
    expect(t).toContain("@max-[34rem]:truncate");
    expect(t).toContain("@max-[34rem]:min-w-0");
    expect(t).toContain("@max-[34rem]:flex-1");
    // and the wide row must NOT clip the name
    expect(t).not.toContain("truncate");
    expect(t).not.toContain("min-w-0");
  } finally {
    view.unmount();
  }
});

test("no width variant other than the narrow one reaches the card", () => {
  // The inversion itself. Every narrow rule is a `@max-[34rem]:` (width <
  // 34rem) variant, so the wide layout is whatever carries no variant at all —
  // unchanged by construction rather than by measurement. Any other width-based
  // variant means something is being layered ON TOP of the wide layout again,
  // which is the shape of bug that broke wide twice.
  //
  // The filter states the property — "the only width decision here is
  // `@max-[34rem]:`" — and lives in one module shared with the provenance row.
  // Four things a "no `@` other than `@max-`" spelling let through: a
  // non-leading container variant (`dark:@[34rem]:`), a viewport breakpoint
  // (`md:hidden`, which decides on the window rather than the dock and bypasses
  // the container system entirely), and `@max-` at the WRONG threshold
  // (`@max-lg:`, `@max-[30rem]:`) — while it also false-positived on
  // `@container` itself.
  //
  // Expanded, and walking the whole card rather than the header button: the
  // card root and the payload region are just as capable of carrying one.
  const view = mount({
    expanded: true,
    result: { result: "ok", createdAt: "2026-08-02T10:04:02.000Z" }
  });
  try {
    const seen = [...view.host.querySelectorAll("*")].flatMap((el) => tokens(el));
    expect(widthVariantOffenders(seen)).toEqual([]);
    // guard the guard: the walk must actually be reaching the narrow tokens
    expect(seen).toContain("@max-[34rem]:flex-wrap");
    // and the utility that establishes the context is not itself an offender
    expect(widthVariantOffenders(["@container"])).toEqual([]);
  } finally {
    view.unmount();
  }
});

test("the tool name and the args summary are visible at every width", () => {
  // The positive half, for the same reason as on the provenance row: the test
  // above bans the wrong variants, which proves nothing about what remains. A
  // later `@max-[34rem]:hidden` on the args span is a well-formed narrow
  // variant that reverts Task 1 — the args summary going to its own line is
  // the entire point — and every other assertion in this file would stay green.
  const view = mount();
  try {
    for (const slot of ["tool-name", "tool-args"]) {
      const el = view.host.querySelector(`[data-slot="${slot}"]`);
      expect(Boolean(el)).toBe(true);
      expect(hidingUtilities(tokens(el!))).toEqual([]);
    }
    expect(view.host.querySelector('[data-slot="tool-name"]')!.textContent).toContain(
      "memory_recall_by_description"
    );
  } finally {
    view.unmount();
  }
});

test("an id dropped from the summary is still there when you expand", () => {
  // The negative assertion above ("not in the summary") passes just as well if
  // someone applies the filter to the expanded rows too. This is the half that
  // notices.
  const view = mount({
    call: {
      toolCallId: "tc11",
      toolName: "task_update",
      args: { taskId: "11111111-1111-4111-8111-111111111111", status: "waiting" }
    }
  });
  try {
    const summary = view.host.querySelector('[data-slot="tool-args"]')!;
    expect(summary.textContent).not.toContain("11111111");

    // Expand, then look again.
    act(() => { view.host.querySelector("button")!.click(); });
    expect(view.host.textContent).toContain("11111111-1111-4111-8111-111111111111");
  } finally { view.unmount(); }
});

test("a canvas publish shows the title from its own result, not the id", () => {
  const view = mount({
    call: { toolCallId: "tc9", toolName: "canvas_publish", args: { canvasId: "cnv_StUv56WxYzA" } },
    result: {
      result: { ok: true, canvasId: "cnv_StUv56WxYzA", title: "Feature report", path: "/canvas/abc" },
      isError: false,
      createdAt: "2026-08-03T10:04:00.000Z"
    }
  });
  try {
    const args = view.host.querySelector('[data-slot="tool-args"]')!;
    expect(args.textContent).toContain("Feature report");
    expect(args.textContent).not.toContain("cnv_StUv56WxYzA");
  } finally { view.unmount(); }
});

test("a canvas publish that failed shows nothing rather than the id", () => {
  // Well-formed apart from the flag, so `ok` is the only thing left to reject
  // it on. A leaner `{ok: false}` fixture was vacuous: it has no title either,
  // so it was rejected for the missing title and the flag was never tested.
  const view = mount({
    call: { toolCallId: "tc10", toolName: "canvas_publish", args: { canvasId: "cnv_StUv56WxYzA" } },
    result: {
      result: { ok: false, canvasId: "cnv_StUv56WxYzA", title: "Feature report", path: "/canvas/abc" },
      isError: false,
      createdAt: "2026-08-03T10:04:00.000Z"
    }
  });
  try {
    const args = view.host.querySelector('[data-slot="tool-args"]')!;
    expect(args.textContent?.trim()).toBe("");
  } finally { view.unmount(); }
});

test("a failed canvas publish is not titled from the payload it still carries", () => {
  // The payload here is a well-formed success shape on purpose, so `isError` is
  // the only thing that can stop it: a call that failed must not be summarised
  // with the title of the canvas it did not publish.
  const view = mount({
    call: { toolCallId: "tc12", toolName: "canvas_publish", args: { canvasId: "cnv_StUv56WxYzA" } },
    result: {
      result: { ok: true, canvasId: "cnv_StUv56WxYzA", title: "Feature report", path: "/canvas/abc" },
      isError: true,
      error: "canvas store is read-only",
      createdAt: "2026-08-03T10:04:00.000Z"
    }
  });
  try {
    const args = view.host.querySelector('[data-slot="tool-args"]')!;
    expect(args.textContent?.trim()).toBe("");
  } finally { view.unmount(); }
});

test("a completed slow tool shows one semantic duration and no absolute tool clock", () => {
  const view = mount({
    result: { result: "ok", createdAt: "2026-08-02T10:09:12.000Z" }
  });
  try {
    const duration = view.host.querySelector('[data-slot="tool-duration"]');
    expect(duration?.tagName).toBe("TIME");
    expect(duration?.textContent).toBe("5m 12s");
    // A duration, not an instant — `dateTime` on a row that reads "5m 12s" has
    // to say the same thing the text does.
    expect(duration?.getAttribute("datetime")).toBe("PT312S");
    expect(duration?.getAttribute("title")).toContain("Completed");
    // The row no longer claims to know when the call started, and it does not
    // repeat the assistant clock it used to borrow for that.
    expect(view.host.querySelector('[data-slot="tool-time"]')).toBeNull();
    expect(view.host.querySelector("button")?.textContent).not.toContain("10:04:00");
    expect(view.host.querySelector("button")?.textContent).not.toContain("10:09:12");
  } finally {
    view.unmount();
  }
});

test("the slow threshold is closed at 1000ms and open just below it", () => {
  // The boundary is the whole reason a duration is ever hidden, so it is pinned
  // from both sides rather than inferred from the "fast" case below.
  const justUnder = mount({ result: { result: "fast", createdAt: "2026-08-02T10:04:00.999Z" } });
  try {
    expect(justUnder.host.querySelector('[data-slot="tool-duration"]')).toBeNull();
  } finally {
    justUnder.unmount();
  }

  const atThreshold = mount({ result: { result: "slow", createdAt: "2026-08-02T10:04:01.000Z" } });
  try {
    const duration = atThreshold.host.querySelector('[data-slot="tool-duration"]');
    expect(duration?.textContent).toBe("1.0s");
    expect(duration?.getAttribute("datetime")).toBe("PT1S");
  } finally {
    atThreshold.unmount();
  }
});

test("fast, running, missing, and invalid tool timings do not invent a duration", () => {
  const cases = [
    { result: { result: "fast", createdAt: "2026-08-02T10:04:00.999Z" } },
    { result: null, isRunning: true },
    // Still flagged running by the wake phase even though the result landed:
    // an in-flight row must not show a duration derived from a stale start.
    { result: { result: "raced", createdAt: "2026-08-02T10:09:12.000Z" }, isRunning: true },
    { result: { result: "missing finish" } },
    { result: { result: "invalid finish", createdAt: "not-a-date" } },
    { result: { result: "reversed", createdAt: "2026-08-02T10:03:59.000Z" } },
    {
      startedAt: "not-a-date",
      result: { result: "invalid start", createdAt: "2026-08-02T10:04:02.000Z" }
    },
    // No preceding completion at all — the caller could not derive a start.
    {
      startedAt: null,
      result: { result: "unknown start", createdAt: "2026-08-02T10:09:12.000Z" }
    }
  ];

  for (const options of cases) {
    const view = mount(options);
    try {
      expect(view.host.querySelector('[data-slot="tool-duration"]')).toBeNull();
    } finally {
      view.unmount();
    }
  }
});

test("ToolCallCard renders view_image result as thumbnail metadata without JSON dump", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const imageBase64 = Buffer.from("png-bytes").toString("base64");

  try {
    await act(async () => {
      root.render(
        <ToolCallCard
          call={{ toolCallId: "call-1", toolName: "view_image", args: { path: "screenshot.png" } }}
          result={{
            result: {
              type: "view_image_result",
              message: "Viewed image: screenshot.png",
              image: {
                type: "image",
                id: "img-1",
                name: "screenshot.png",
                displayPath: "screenshot.png",
                mediaType: "image/png",
                data: imageBase64,
                sizeBytes: 9
              }
            }
          }}
          isRunning={false}
          expanded
        />
      );
    });

    expect(container.textContent).toContain("Viewed image: screenshot.png");
    expect(container.textContent).toContain("image/png, 9 B");
    expect(container.textContent).not.toContain("view_image_result");
    expect(container.textContent).not.toContain(imageBase64);
    const img = container.getElementsByTagName("img")[0]!;
    expect(img.getAttribute("src")).toBe(`data:image/png;base64,${imageBase64}`);
    expect(img.getAttribute("alt")).toBe("screenshot.png");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});
