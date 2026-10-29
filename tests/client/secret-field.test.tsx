import { expect, test } from "bun:test";
import { act, useState } from "react";
import { SecretField } from "@/routes/settings/settings-fields";
import { mount } from "../helpers/mount.js";

// The API key field shows one state at a time: a field to paste a key when
// none is saved; "Saved" with Replace and Remove when one is; "Removed when
// you save" with Undo once Remove is pressed.

let latest = { value: "", clear: false };
let setFromOutside: (value: string) => void = () => {};

function Harness({ configured, getKeyUrl, initial = "" }: { configured: boolean; getKeyUrl?: string; initial?: string }) {
  const [value, setValue] = useState(initial);
  const [clear, setClear] = useState(false);
  latest = { value, clear };
  setFromOutside = setValue;
  return (
    <SecretField
      configured={configured}
      value={value}
      clear={clear}
      getKeyUrl={getKeyUrl}
      onValueChange={setValue}
      onClearChange={setClear}
    />
  );
}

function render(configured: boolean, getKeyUrl?: string, initial?: string): HTMLElement {
  return mount(<Harness configured={configured} getKeyUrl={getKeyUrl} initial={initial} />).host;
}

const button = (host: HTMLElement, name: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined;

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  });
}

test("with no key saved: a field to paste one, and the provider's key page", () => {
  const host = render(false, "https://keys.example/new");
  const input = host.querySelector("input") as HTMLInputElement;
  expect([input.type, input.getAttribute("aria-label"), input.placeholder]).toEqual(["password", "API key", "Paste key"]);
  const link = host.querySelector("a") as HTMLAnchorElement;
  expect([link.textContent?.trim(), link.getAttribute("href"), link.target]).toEqual(["Get a key", "https://keys.example/new", "_blank"]);
  expect(host.textContent).not.toContain("Saved");
});

test("no key page, no link", () => {
  expect(render(false).querySelector("a") === null).toBe(true);
});

test("a saved key reads Saved with Replace and Remove, and no field", () => {
  const host = render(true, "https://keys.example/new");
  expect(host.textContent).toContain("Saved");
  expect([Boolean(button(host, "Replace")), Boolean(button(host, "Remove"))]).toEqual([true, true]);
  expect(host.querySelector("input") === null).toBe(true);
  expect(host.querySelector("a") === null).toBe(true);
});

test("Replace opens an empty field, focused; Cancel drops what was typed and goes back to Saved", () => {
  const host = render(true);
  act(() => button(host, "Replace")!.click());
  const input = host.querySelector("input") as HTMLInputElement;
  expect([input.value, input.placeholder, document.activeElement === input]).toEqual(["", "Paste the new key", true]);
  type(input, "sk-new");
  expect(latest.value).toBe("sk-new");
  act(() => button(host, "Cancel")!.click());
  expect(latest.value).toBe("");
  expect(host.querySelector("input") === null).toBe(true);
  expect(host.textContent).toContain("Saved");
});

test("once a replacement is saved (the form's key empties again), the field is back to Saved", () => {
  const host = render(true);
  act(() => button(host, "Replace")!.click());
  type(host.querySelector("input") as HTMLInputElement, "sk-new");
  act(() => setFromOutside(""));
  expect(host.querySelector("input") === null).toBe(true);
  expect(host.textContent).toContain("Saved");
});

test("Remove marks the key for removal on save; Undo takes it back", () => {
  const host = render(true);
  act(() => button(host, "Remove")!.click());
  expect(latest.clear).toBe(true);
  expect(host.textContent).toContain("Removed when you save");
  act(() => button(host, "Undo")!.click());
  expect(latest.clear).toBe(false);
  expect(host.textContent).toContain("Saved");
});

// Deleting what was typed is not a save landing: the field stayed open only
// for a moment, then folded back to Saved under the keys.
test("a replacement typed and deleted again keeps the field open", () => {
  const host = render(true);
  act(() => button(host, "Replace")!.click());
  const input = host.querySelector("input") as HTMLInputElement;
  type(input, "sk-a");
  type(input, "");
  expect(host.querySelector("input") === input).toBe(true);
  expect(host.textContent).not.toContain("Saved");
});

// A page opened again with a key typed and not saved shows the field, but
// does not take the keys: it grabbed focus on every visit.
test("a field shown because a key is typed already does not take focus; Replace does", () => {
  const host = render(true, undefined, "sk-typed");
  const input = host.querySelector("input") as HTMLInputElement;
  expect([input.value, document.activeElement === input]).toEqual(["sk-typed", false]);
});
