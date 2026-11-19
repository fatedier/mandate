import { expect, test } from "bun:test";
import { act } from "react";
import { SearchSelect, type SearchSelectOption } from "@/components/ui/search-select";
import { mountAsync, typeInto } from "../helpers/mount.js";

const OPTIONS: SearchSelectOption[] = [
  { value: "", label: "Any model" },
  { value: "a", label: "gateway / anthropic/claude-opus-5-5" },
  { value: "b", label: "gateway / deepseek/deepseek-v4-flash" },
  { value: "c", label: "mirror / anthropic/claude-OPUS-4-5" }
];

async function render(value = "", onValueChange: (value: string) => void = () => {}) {
  const { host } = await mountAsync(
    <SearchSelect aria-label="Model" value={value} options={OPTIONS} searchPlaceholder="Search models…" onValueChange={onValueChange} />
  );
  return host;
}

const trigger = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[aria-label="Model"]')!;
const listed = () => [...document.querySelectorAll('[cmdk-item]')].map((item) => item.textContent);
const search = () => document.querySelector<HTMLInputElement>("[cmdk-input]")!;

async function open(host: HTMLElement) {
  await act(async () => { trigger(host).click(); });
}

const type = (text: string) => typeInto(search(), text);

/** cmdk picks on Enter by dispatching `new Event(...)` on the item. In a
 *  browser that is the DOM's one Event; here the global is Bun's, which
 *  happy-dom refuses (and which other tests dispatch on Bun's own targets, so
 *  it stays Bun's), so a key is pressed with the DOM's Event in place. */
async function key(name: string) {
  const native = globalThis.Event;
  globalThis.Event = window.Event as unknown as typeof Event;
  try {
    await act(async () => { search().dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true })); });
  } finally {
    globalThis.Event = native;
  }
}

test("the trigger names the chosen option, or the any-option when none is chosen", async () => {
  expect(trigger(await render()).textContent).toBe("Any model");
  expect(trigger(await render("b")).textContent).toBe("gateway / deepseek/deepseek-v4-flash");
});

test("opened, it lists every option with a search box", async () => {
  const host = await render();
  await open(host);
  expect(search().getAttribute("placeholder")).toBe("Search models…");
  expect(listed()).toEqual(OPTIONS.map((option) => option.label));
});

test("typing keeps the options whose name holds the text, in any case, and marks it", async () => {
  const host = await render();
  await open(host);
  await type("opus");
  // The any-option is not a name to match: it goes while a search is typed.
  expect(listed()).toEqual(["gateway / anthropic/claude-opus-5-5", "mirror / anthropic/claude-OPUS-4-5"]);
  expect([...document.querySelectorAll("[cmdk-item] mark")].map((mark) => mark.textContent)).toEqual(["opus", "OPUS"]);
});

test("a search nothing holds says so", async () => {
  const host = await render();
  await open(host);
  await type("zzz");
  expect(listed()).toEqual([]);
  expect(document.querySelector("[cmdk-empty]")?.textContent).toBe("No match");
});

test("Enter picks the first match, and the list closes", async () => {
  const seen: string[] = [];
  const host = await render("", (value) => { seen.push(value); });
  await open(host);
  await type("flash");
  await key("Enter");
  expect(seen).toEqual(["b"]);
  expect(search() === null).toBe(true);
});

test("the arrow keys move along the matches before Enter picks", async () => {
  const seen: string[] = [];
  const host = await render("", (value) => { seen.push(value); });
  await open(host);
  await type("opus");
  await key("ArrowDown");
  await key("Enter");
  expect(seen).toEqual(["c"]);
});

test("a click picks an option; the any-option clears the choice", async () => {
  const seen: string[] = [];
  const host = await render("a", (value) => { seen.push(value); });
  await open(host);
  const any = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find((item) => item.textContent === "Any model")!;
  await act(async () => { any.click(); });
  expect(seen).toEqual([""]);
});

test("the list opens on the chosen option, marked, so Enter keeps it", async () => {
  const host = await render("c");
  await open(host);
  const chosen = document.querySelector("[cmdk-item][data-chosen]");
  expect(chosen?.textContent).toBe("mirror / anthropic/claude-OPUS-4-5");
  expect(chosen?.getAttribute("aria-selected")).toBe("true");
});

test("Escape closes the list, but not while an input method is composing", async () => {
  const host = await render();
  await open(host);
  // A Chinese input method cancels what is being composed with Escape: the
  // search stays open, and what was typed stays.
  await act(async () => {
    search().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true }));
  });
  expect(search()).not.toBeNull();
  await act(async () => {
    search().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(search() === null).toBe(true);
});
