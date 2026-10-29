import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { SettingRow, SettingSubGroup } from "@/routes/settings/SettingRow";
import { mount } from "../helpers/mount.js";

function render(node: ReactNode): HTMLElement {
  return mount(node).host;
}

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

  // On a phone the control goes under the description, 10px below it, as a
  // stacked row's does; only one field used to add that gap itself.
  test("on a phone a side-by-side row's control sits 10px under the description", () => {
    for (const fit of ["field", "wide", "auto"] as const) {
      const c = render(
        <SettingRow label="Theme" description="System follows the OS appearance." fit={fit}>
          <button data-control />
        </SettingRow>
      );
      const tokens = controlCell(c).className.split(/\s+/);
      expect(tokens).toContain("mt-2.5");
      expect(tokens).toContain("sm:mt-0");
    }
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
    expect(c.querySelector("[data-control]") === null).toBe(true);
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
