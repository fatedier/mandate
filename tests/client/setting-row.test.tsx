import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingRow, SettingSubGroup } from "@/routes/settings/SettingRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(node: ReactNode): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

function row(c: HTMLElement): HTMLElement {
  const el = c.firstElementChild;
  if (!el) throw new Error("expected the row to render");
  return el as HTMLElement;
}

/** The control lives in the row's second grid cell. */
function controlCell(c: HTMLElement): HTMLElement {
  const el = c.querySelector("[data-control]");
  if (!el) throw new Error("expected the control wrapper");
  return el.parentElement as HTMLElement;
}

/** SettingRow is the two-column primitive every pane is built from: name and
 *  description left, control right. These pin the geometry the panes rely on —
 *  the shared control gutter, the stacked escape hatch, and the search anchor
 *  the settings shell scrolls to. */
describe("SettingRow", () => {
  test("renders label, description and hint, and the control keeps the field gutter", () => {
    const c = render(
      <SettingRow label="Port" description="Use 0 to pick one automatically." hint="Restart to apply.">
        <input data-control />
      </SettingRow>
    );
    expect(c.textContent).toContain("Port");
    expect(c.textContent).toContain("Use 0 to pick one automatically.");
    expect(c.textContent).toContain("Restart to apply.");
    const cell = controlCell(c);
    expect(cell.className).toContain("sm:w-72");
    expect(cell.className).toContain("sm:justify-self-end");
  });

  test("fit=auto drops the fixed width so switches and button clusters hug the edge", () => {
    const c = render(
      <SettingRow label="Theme" fit="auto">
        <button data-control />
      </SettingRow>
    );
    const cell = controlCell(c);
    expect(cell.className).not.toContain("sm:w-72");
    expect(cell.className).not.toContain("sm:w-80");
    expect(cell.className).toContain("sm:justify-self-end");
  });

  test("fit=wide gets the roomier gutter that fully-qualified model refs need", () => {
    const c = render(
      <SettingRow label="Model" fit="wide">
        <select data-control />
      </SettingRow>
    );
    expect(controlCell(c).className).toContain("sm:w-80");
  });

  test("stacked puts the control on its own line with no gutter width or grid", () => {
    const c = render(
      <SettingRow label="Delegation preferences" stacked>
        <textarea data-control />
      </SettingRow>
    );
    const cell = controlCell(c);
    expect(cell.className).not.toContain("sm:justify-self-end");
    expect(cell.className).not.toContain("sm:w-72");
    // The grid only exists in the side-by-side layout.
    const inner = row(c).firstElementChild as HTMLElement;
    expect(inner.className).not.toContain("sm:grid");
  });

  test("anchor becomes the id the settings shell scrolls to and flashes", () => {
    const c = render(
      <SettingRow anchor="web-port" label="Port">
        <input data-control />
      </SettingRow>
    );
    expect(row(c).id).toBe("setting-web-port");
    expect(row(c).getAttribute("data-setting-anchor")).toBe("web-port");
    expect(row(c).className).toContain("scroll-mt-4");
  });

  test("no anchor means no id — an empty id would collide across rows", () => {
    const c = render(
      <SettingRow label="Port">
        <input data-control />
      </SettingRow>
    );
    expect(row(c).id).toBe("");
    expect(row(c).hasAttribute("data-setting-anchor")).toBe(false);
  });

  test("a row with no control still renders its label", () => {
    const c = render(<SettingRow label="Read only" description="Nothing to set." />);
    expect(c.textContent).toContain("Read only");
    expect(c.querySelector("[data-control]")).toBeNull();
  });
});

describe("SettingSubGroup", () => {
  test("renders a quiet caption, its action, and the children below", () => {
    const c = render(
      <SettingSubGroup label="Fallbacks" action={<button>Add fallback</button>}>
        <div>ROWS</div>
      </SettingSubGroup>
    );
    expect(c.textContent).toContain("Fallbacks");
    expect(c.textContent).toContain("Add fallback");
    expect(c.textContent).toContain("ROWS");
    const caption = Array.from(c.getElementsByTagName("span")).find(
      (el) => el.textContent === "Fallbacks"
    );
    expect(caption?.className).toContain("label-micro");
    expect(caption?.className).toContain("text-chrome");
  });
});
