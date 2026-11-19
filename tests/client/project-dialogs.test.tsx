import { expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { NewProjectDialog } from "@/routes/projects/NewProjectDialog";
import { mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";

// New project was a dialog with bare inputs (Adopt, now gone, was the other): focused, they
// drew the browser's own thick outline (black, white in the dark theme) where
// every other field draws the app's ring. They use the setup
// pages' TextInput, and the name still takes focus when the dialog opens.
const inputs = () => [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input')];
const ringed = (input: HTMLInputElement) => {
  const tokens = input.className.split(/\s+/);
  return ["outline-none", "focus:ring-[3px]", "focus:ring-ring/20", "focus:border-ring"].every((t) => tokens.includes(t));
};

test("New project's fields draw the app's focus ring, and the name takes focus", async () => {
  mockFetch(() => Response.json({}));
  const { host } = await mountAsync(<MemoryRouter><NewProjectDialog /></MemoryRouter>);
  await act(async () => { host.querySelector("button")!.click(); });
  await settle();
  expect(inputs()).toHaveLength(2);
  expect(inputs().every(ringed)).toBe(true);
  expect(document.activeElement === inputs()[0]!).toBe(true);
});
