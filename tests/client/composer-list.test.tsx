import { expect, test } from "bun:test";
import { ComposerList } from "@/routes/window/chat/ComposerList";
import { composerOptionId } from "@/routes/window/chat/composer-option-id";
import { mount } from "../helpers/mount.js";

// The one listbox the composer shows over itself, for its commands and for
// what @ can name: headed groups, the picked option marked, and a pick taken
// on the way down so the caret never leaves the textarea.
test("a composer list shows each group's heading, marks the picked option, and picks on mouse down", () => {
  const picks: string[] = [];
  const { host } = mount(
    <ComposerList
      id="list"
      label="Threads"
      picked={1}
      rowClassName="items-center gap-2.5"
      onPick={(key) => picks.push(key)}
      groups={[
        { heading: "Threads", options: [{ key: "a", content: "First" }, { key: "b", content: "Second" }] },
        { heading: "Workers", options: [{ key: "c", content: <span>Third</span>, attributes: { "data-blocked": "" } }] }
      ]}
    />
  );
  const listbox = host.querySelector('[role="listbox"]')!;
  expect(listbox.getAttribute("aria-label")).toBe("Threads");
  const options = [...host.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(options.map((o) => o.textContent)).toEqual(["First", "Second", "Third"]);
  expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
  expect(options[1]!.id).toBe(composerOptionId("list", "b"));
  // An option's own data attributes and content land on the option itself.
  expect(options[2]!.hasAttribute("data-blocked")).toBe(true);
  expect(options[2]!.children[0]!.textContent).toBe("Third");
  // Headings are text in the list, not options.
  expect(listbox.textContent).toContain("Workers");
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  options[2]!.dispatchEvent(down);
  expect(picks).toStrictEqual(["c"]);
  expect(down.defaultPrevented).toBe(true);
});

test("the picked index counts across groups", () => {
  const { host } = mount(
    <ComposerList id="list" label="Mentions" picked={2} onPick={() => {}} groups={[
      { heading: "Threads", options: [{ key: "a", content: "First" }, { key: "b", content: "Second" }] },
      { heading: "Workers", options: [{ key: "c", content: "Third" }] }
    ]} />
  );
  expect([...host.querySelectorAll('[role="option"]')].map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "false", "true"]);
});

// Focus stays in the textarea, so nothing scrolls the list for it: a pick
// moved past the list's height is scrolled into view by the list itself,
// and only the list scrolls (scrollIntoView would move the page around it,
// as on an iPhone with the keyboard open).
test("the picked option is scrolled into view inside the list alone whenever the pick moves", () => {
  const scrolled: string[] = [];
  // Recorded on Element.prototype and put back from its own descriptor: an
  // own property left on HTMLElement.prototype would shadow the next test's.
  const saved = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true, writable: true,
    value(this: Element) { scrolled.push(this.id); }
  });
  try {
    const options = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, content: `Row ${i}` }));
    const list = (picked: number) => <ComposerList id="list" label="Commands" picked={picked} onPick={() => {}} groups={[{ options }]} />;
    const { host, rerender } = mount(list(0));
    // A list 100px high of 30px rows, laid out by hand (the test DOM has no layout).
    const listbox = host.querySelector<HTMLElement>('[role="listbox"]')!;
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    listbox.getBoundingClientRect = () => rect(0, 100);
    [...host.querySelectorAll<HTMLElement>('[role="option"]')].forEach((row, i) => {
      row.getBoundingClientRect = () => rect(i * 30 - listbox.scrollTop, 30);
    });
    rerender(list(11));
    expect(listbox.scrollTop).toBe(12 * 30 - 100);
    // One already in view leaves the list where it is.
    rerender(list(9));
    expect(listbox.scrollTop).toBe(12 * 30 - 100);
    rerender(list(0));
    expect(listbox.scrollTop).toBe(0);
    expect(scrolled).toStrictEqual([]);
  } finally {
    if (saved) Object.defineProperty(Element.prototype, "scrollIntoView", saved);
    else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});
