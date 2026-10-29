import { expect, test } from "bun:test";
import { sheetStep, type SheetStepFacts } from "@/routes/threads/sheet-back-step";

// On a phone the worker sheet is a step in the history, so Back
// closes it before it leaves the thread. One reconciler keeps the sheet (the
// store) and its step (a marked history entry) together; these are its rules.

const facts = (over: Partial<SheetStepFacts>): SheetStepFacts =>
  ({ open: false, marked: false, key: "k1", step: null, covered: false, phone: true, ...over });

test("opening the sheet adds its step, once", () => {
  expect(sheetStep(facts({ open: true }))).toEqual({ do: "add", step: "pending" });
  // The step is on its way: a location that is not it yet changes nothing.
  expect(sheetStep(facts({ open: true, step: "pending", key: "k1b" }))).toEqual({ do: "none", step: "pending" });
  // It arrived: this entry is the step.
  expect(sheetStep(facts({ open: true, marked: true, key: "k2", step: "pending" }))).toEqual({ do: "none", step: "k2" });
  expect(sheetStep(facts({ open: true, marked: true, key: "k2", step: "k2" }))).toEqual({ do: "none", step: "k2" });
});

test("Back takes the step, and the sheet closes", () => {
  expect(sheetStep(facts({ open: true, marked: false, key: "k1", step: "k2" }))).toEqual({ do: "close", step: null });
  expect(sheetStep(facts({ open: false, marked: false, key: "k1", step: null }))).toEqual({ do: "none", step: null });
});

test("a sheet closed any other way takes its own step back, and waits for it to go", () => {
  expect(sheetStep(facts({ open: false, marked: true, key: "k2", step: "k2" }))).toEqual({ do: "back", step: "leaving" });
  expect(sheetStep(facts({ open: false, marked: true, key: "k2", step: "leaving" }))).toEqual({ do: "none", step: "leaving" });
  expect(sheetStep(facts({ open: false, marked: false, key: "k1", step: "leaving" }))).toEqual({ do: "none", step: null });
  // Closed before its step was seen: the step is still this page's to take back.
  expect(sheetStep(facts({ open: false, marked: false, key: "k1", step: "pending" }))).toEqual({ do: "none", step: "pending" });
  expect(sheetStep(facts({ open: false, marked: true, key: "k2", step: "pending" }))).toEqual({ do: "back", step: "leaving" });
});

test("under a canvas nothing is done: the history's top entry is the canvas's", () => {
  // Rotated to a wide screen while a canvas is open over the sheet: the sheet
  // closes, and its step waits until the canvas is gone.
  expect(sheetStep(facts({ open: false, marked: true, key: "k2", step: "k2", covered: true }))).toEqual({ do: "none", step: "k2" });
  expect(sheetStep(facts({ open: false, marked: true, key: "k2", step: "k2", covered: false }))).toEqual({ do: "back", step: "leaving" });
  // Opened by an agent while a canvas is open: its step waits too.
  expect(sheetStep(facts({ open: true, marked: false, step: null, covered: true }))).toEqual({ do: "none", step: null });
});

test("arriving on a step from somewhere else reopens the sheet on a phone, and unmarks the entry on a wide screen", () => {
  expect(sheetStep(facts({ open: false, marked: true, key: "k2", step: null, phone: true }))).toEqual({ do: "reopen", step: "k2" });
  expect(sheetStep(facts({ open: false, marked: true, key: "k2", step: null, phone: false }))).toEqual({ do: "strip", step: null });
  // A step left by an entry this page no longer stands on is not this one.
  expect(sheetStep(facts({ open: false, marked: true, key: "k9", step: "k2", phone: true }))).toEqual({ do: "reopen", step: "k9" });
});

test("a wide screen has no sheet and adds no step", () => {
  expect(sheetStep(facts({ open: true, phone: false }))).toEqual({ do: "none", step: null });
});
