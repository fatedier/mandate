import { expect, test } from "bun:test";
import { act } from "react";
import { QuestionCallout } from "@/components/QuestionCallout";
import { mount, typeInto } from "../helpers/mount.js";

// The question on a worker's card: one line, with a reply sent to the worker
// from where the card is. The same component as the block above a composer.

const QUESTION = "May I run the full build in a loop to catch the flaky test?";
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); await Promise.resolve(); }); };
const button = (host: HTMLElement, name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === name) ?? null;
const reply = (host: HTMLElement) => host.querySelector("textarea");
const type = (host: HTMLElement, text: string) => typeInto(reply(host)!, text);
const key = (host: HTMLElement, name: string, init: KeyboardEventInit = {}) => act(async () => {
  reply(host)!.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
  await Promise.resolve();
});

test("on a card the question is one line with a reply: Reply opens an input, Enter sends it once, and the card says it went", async () => {
  const sent: string[] = [];
  const { host } = mount(<QuestionCallout question={QUESTION} onSend={(text) => { sent.push(text); }} />);
  expect(host.textContent).toBe(`${QUESTION}Reply ↵`);
  // The whole question is on the line's title: the line itself is cut to fit.
  expect(host.querySelector(`[title="${QUESTION}"]`)!.textContent).toBe(QUESTION);
  expect(reply(host) === null).toBe(true);
  await click(button(host, "Reply ↵"));
  expect(reply(host)!.getAttribute("placeholder")).toBe("Reply to the worker…");
  expect(button(host, "Send")!.disabled).toBe(true);
  await type(host, "  Yes, three runs.  ");
  await key(host, "Enter");
  expect(sent).toStrictEqual(["Yes, three runs."]);
  expect(reply(host) === null).toBe(true);
  expect(host.textContent).toBe(`${QUESTION}sent — agent resuming`);
});

test("a reply takes more than one line: Shift+Enter is a new line, Enter sends it whole", async () => {
  const sent: string[] = [];
  const { host } = mount(<QuestionCallout question={QUESTION} onSend={(text) => { sent.push(text); }} />);
  await click(button(host, "Reply ↵"));
  await type(host, "Yes, three runs.\nStop at the first failure.");
  await key(host, "Enter", { shiftKey: true });
  expect(sent).toStrictEqual([]);
  await key(host, "Enter");
  expect(sent).toStrictEqual(["Yes, three runs.\nStop at the first failure."]);
});

// The field is drawn only while a reply is open: put away and opened again,
// it is fitted to the reply it still holds, not left a line tall.
test("a reply put away with Escape and opened again is fitted to what it holds", async () => {
  const { host } = mount(<QuestionCallout question={QUESTION} onSend={() => {}} />);
  await click(button(host, "Reply ↵"));
  await type(host, "Yes, three runs.\nStop at the first failure.");
  expect(reply(host)!.style.height === "").toBe(false);
  await key(host, "Escape");
  await click(button(host, "Reply ↵"));
  expect([reply(host)!.value, reply(host)!.style.height === ""]).toStrictEqual(["Yes, three runs.\nStop at the first failure.", false]);
});

test("a reply that could not be sent says so and keeps what was typed; Escape puts the input away", async () => {
  let fail = true;
  const { host } = mount(<QuestionCallout question={QUESTION} onSend={async () => { if (fail) throw new Error("offline"); }} />);
  await click(button(host, "Reply ↵"));
  await type(host, "Yes.");
  await click(button(host, "Send"));
  expect(host.textContent).toContain("Failed to send — try again");
  expect(reply(host)!.value).toBe("Yes.");
  fail = false;
  await key(host, "Escape");
  expect(reply(host) === null).toBe(true);
  expect(button(host, "Reply ↵")).not.toBeNull();
});

test("a new question on the same card is not marked as replied to", async () => {
  const view = mount(<QuestionCallout question={QUESTION} onSend={() => {}} />);
  await click(button(view.host, "Reply ↵"));
  await type(view.host, "Yes.");
  await click(button(view.host, "Send"));
  expect(view.host.textContent).toContain("sent — agent resuming");
  view.rerender(<QuestionCallout question="And on the release branch too?" onSend={() => {}} />);
  expect(view.host.textContent).toBe("And on the release branch too?Reply ↵");
});

// A worker's question is its manager's first (amber, as the worker's own
// state); once it is the user's to answer it wears the questions' yellow.
test("a question waiting on its manager is amber; one waiting on the user is yellow", () => {
  const frame = (host: HTMLElement) => host.firstElementChild!.className.split(/\s+/);
  const managers = mount(<QuestionCallout question={QUESTION} tone="manager" />).host;
  expect(frame(managers)).toEqual(expect.arrayContaining(["border-amber/40", "bg-amber/8"]));
  expect(frame(managers).some((c) => c.includes("status-input"))).toBe(false);
  expect(managers.querySelector("svg")!.getAttribute("class")).toContain("text-amber");
  const users = mount(<QuestionCallout question={QUESTION} />).host;
  expect(frame(users)).toEqual(expect.arrayContaining(["border-status-input/40", "bg-status-input/8"]));
});
