import { expect, test } from "bun:test";
import { formatDueLabel } from "@/routes/task-board/task-format";

// A task's due date as a card or row says it (short) and as its Due field
// says it (long): the date always given, the day beside it this week, the
// year only in another year; red when past, amber today.

const NOW = new Date(2026, 10, 11, 10, 0).getTime(); // Wednesday, Nov 11 2026, here

test("a card's due: Today, Tomorrow, the day and date in the coming week, the date later; red past, amber today", () => {
  const days = ["2026-11-08", "2026-11-11", "2026-11-12", "2026-11-17", "2026-11-18", "2026-11-26"];
  expect(days.map((d) => formatDueLabel(d, null, NOW).short)).toEqual(["Overdue · Nov 8", "Today", "Tomorrow", "Tue, Nov 17", "Nov 18", "Nov 26"]);
  expect(days.map((d) => formatDueLabel(d, null, NOW).tone)).toEqual(["overdue", "today", null, null, null, null]);
  expect(formatDueLabel("2026-11-11", "14:00", NOW).short).toBe("Today · 14:00");
  expect(formatDueLabel("2026-11-17", "09:30", NOW).long).toBe("Tue, Nov 17 · 09:30");
});

test("a date in another year carries its year, on the card and in the Due field", () => {
  expect(formatDueLabel("2027-01-05", null, NOW)).toMatchObject({ short: "Jan 5, 2027", long: "Tue, Jan 5, 2027" });
  expect(formatDueLabel("2025-12-30", null, NOW)).toMatchObject({ short: "Overdue · Dec 30, 2025", long: "Tue, Dec 30, 2025 · overdue" });
});
