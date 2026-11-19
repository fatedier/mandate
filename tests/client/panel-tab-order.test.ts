import { expect, test } from "bun:test";
import { completeOrder, movedOrder, orderedIds, orderedTabs, reconciledOrder } from "@/lib/panel-tabs";

// A right panel's tabs in the order the person dragged them into: the ids
// ordered first, the rest after them as the row has them; a drop moves a tab
// to the place of the one it was dropped on, in the panel's whole order.

test("no order: the row as it is", () => {
  expect(orderedIds(["a", "b", "c"], undefined)).toEqual(["a", "b", "c"]);
});

test("an order puts its tabs first in its order, then the rest as the row has them; gone ids are skipped", () => {
  expect(orderedIds(["a", "b", "c", "new1", "new2"], ["c", "gone", "a", "b"])).toEqual(["c", "a", "b", "new1", "new2"]);
  expect(orderedTabs([{ id: "a" }, { id: "b" }], ["b", "a"]).map((t) => t.id)).toEqual(["b", "a"]);
});

test("a tab dropped on another takes its place; hidden tabs keep theirs", () => {
  expect(movedOrder(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  expect(movedOrder(["a", "b", "c"], "a", "b")).toEqual(["b", "a", "c"]);
  // c1 hidden in the row: C dropped on A, as the sheet shows [A, B, C].
  expect(movedOrder(["A", "c1", "B", "C"], "C", "A")).toEqual(["C", "A", "c1", "B"]);
  expect(movedOrder(["a", "b"], "a", "missing")).toEqual(["a", "b"]);
  expect(movedOrder(["a", "b"], "a", "a")).toEqual(["a", "b"]);
});

test("an order, once there, lists every tab: one that comes goes last, one gone leaves", () => {
  expect(reconciledOrder(["b", "a"], ["a", "b", "c"])).toEqual(["b", "a", "c"]);
  expect(reconciledOrder(["b", "t", "a"], ["a", "b"])).toEqual(["b", "a"]);
  expect(reconciledOrder(["b", "a"], ["b", "a"])).toEqual(["b", "a"]);
});

test("a drop's whole order is the saved one with any tab not in it yet after", () => {
  expect(completeOrder(undefined, ["a", "b"])).toEqual(["a", "b"]);
  expect(completeOrder(["b", "t", "a"], ["a", "b", "c"])).toEqual(["b", "t", "a", "c"]);
  // A tab dropped among them: the one whose list has not come stays where it is.
  expect(movedOrder(completeOrder(["a", "t", "b"], ["a", "b"]), "a", "b")).toEqual(["t", "b", "a"]);
});

test("tabs that came while the order was not looked after go last in the order they came, the server's by when it made them", () => {
  const came = new Map([["reply:r1", 100], ["thread:t1", 200]]);
  expect(reconciledOrder(["c"], ["c", "thread:t1", "reply:r1", "x"], (id) => came.get(id) ?? Infinity)).toEqual(["c", "reply:r1", "thread:t1", "x"]);
});

test("while the server's lists are not all in, its tabs wait: those in the order keep their places, new ones join later; the panel's own join at once", () => {
  const server = (id: string) => id.startsWith("thread:") || id.startsWith("reply:");
  expect(reconciledOrder(["c"], ["c", "x", "thread:t"], () => Infinity, server)).toEqual(["c", "x"]);
  expect(reconciledOrder(["thread:t", "c"], ["c", "y"], () => Infinity, server)).toEqual(["thread:t", "c", "y"]);
});
