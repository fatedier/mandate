import { expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { BackLink, InlineError, LoadingLine, StateAction, StateMessage } from "@/components/ViewState";
import { mount } from "../helpers/mount.js";

test("StateMessage: title, sentence, detail and one action, frameless and not red", () => {
  const { host } = mount(
    <MemoryRouter>
      <StateMessage title="Canvas not found" detail="request failed (404)" action={<BackLink to="/home">Back to Home</BackLink>} heading="h1">
        It was deleted, or the link is wrong.
      </StateMessage>
    </MemoryRouter>
  );
  const box = host.querySelector('[data-slot="state-message"]')!;
  expect(box.querySelector("h1")!.textContent).toBe("Canvas not found");
  expect([...box.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["It was deleted, or the link is wrong.", "request failed (404)"]);
  expect(box.querySelector("a")!.getAttribute("href")).toBe("/home");
  expect(box.querySelector("a")!.textContent).toBe("Back to Home");
  // No frame, no red: nothing here asks to be dealt with beyond the action.
  expect(box.className).not.toMatch(/\bborder\b|destructive|red/);
  expect(box.innerHTML).not.toMatch(/destructive|text-red/);
});

test("StateMessage: heading defaults to h2; the sentence, detail and action are optional", () => {
  const { host } = mount(<StateMessage title="Worker not found" />);
  const box = host.querySelector('[data-slot="state-message"]')!;
  expect(box.querySelector("h2")!.textContent).toBe("Worker not found");
  expect(box.querySelectorAll("p")).toHaveLength(0);
  expect(box.querySelector("a, button") === null).toBe(true);
});

test("StateAction runs its handler", () => {
  let clicks = 0;
  const { host } = mount(<StateMessage title="Couldn't load this pane" action={<StateAction onClick={() => { clicks++; }}>Retry</StateAction>} />);
  act(() => host.querySelector("button")!.click());
  expect(clicks).toBe(1);
});

test("InlineError: an alert with a red icon, the sentence, Retry, and the detail below", () => {
  let retries = 0;
  const { host } = mount(<InlineError detail="upstream connect error" onRetry={() => { retries++; }}>Couldn't load settings.</InlineError>);
  const alert = host.querySelector('[data-slot="inline-error"]')!;
  expect(alert.getAttribute("role")).toBe("alert");
  expect(alert.querySelector("svg")!.getAttribute("class")).toContain("text-destructive");
  expect(alert.textContent).toContain("Couldn't load settings.");
  expect(alert.querySelector("p")!.textContent).toBe("upstream connect error");
  const retry = alert.querySelector("button")!;
  expect(retry.textContent).toBe("Retry");
  act(() => retry.click());
  expect(retries).toBe(1);
});

test("InlineError without a retry or detail is just the line", () => {
  const { host } = mount(<InlineError>Couldn't load the live state.</InlineError>);
  const alert = host.querySelector('[data-slot="inline-error"]')!;
  expect(alert.querySelector("button") === null).toBe(true);
  expect(alert.querySelector("p") === null).toBe(true);
});

test("LoadingLine says Loading… as a status, with no spinner", () => {
  const { host } = mount(<LoadingLine />);
  const line = host.querySelector('[data-slot="loading-line"]')!;
  expect(line.getAttribute("role")).toBe("status");
  expect(line.textContent).toBe("Loading…");
  expect(line.querySelector("svg") === null).toBe(true);
  expect(line.className).not.toContain("animate");
});
