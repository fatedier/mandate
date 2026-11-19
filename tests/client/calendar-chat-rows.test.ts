import { expect, test } from "bun:test";
import { causeForTriggerMessage, triggerReason } from "@/routes/window/chat/chatProvenance";
import { agentMessage } from "../helpers/typed.js";

// A due calendar entry's message wakes the personal agent: its row in the chat
// reads Calendar and the entry's title, its note to be opened.

const due = (text: string) => agentMessage({ role: "user", source: "calendar", content: { type: "text", text } });

test("a calendar message is its wake's trigger row: Calendar, the title, the note", () => {
  const message = due('Calendar: "Weekly progress notes" (every Monday 09:00) is due.\nRead last week\'s tasks.\nWrite a short draft.');
  expect(triggerReason(message)).toBe("calendar");
  const row = causeForTriggerMessage(message, () => null);
  expect([row?.label, row?.detail, row?.facts?.note]).toEqual(["Calendar", "Weekly progress notes", "Read last week's tasks.\nWrite a short draft."]);
});

test("a title that holds what a rule begins with is read to its last quote, on time and late", () => {
  for (const text of [
    'Calendar: "Review "Roadmap" (first draft)" (every Monday 09:00) is due.\nn',
    'Calendar: "Review "Roadmap" (first draft)" (once Mon 16 Nov 10:00) was due at Mon 16 Nov 10:00 and comes late, at 09:30.\nn'
  ]) expect(causeForTriggerMessage(due(text), () => null)?.detail).toBe('Review "Roadmap" (first draft)');
});

test("a late one says when it was due; a title with quotes and parentheses is read whole", () => {
  const message = due('Calendar: "Review (all) "the" schedules" (every Monday 09:00 (America/New_York)) was due at 09:00 and comes late, at 11:12; 2 earlier times were missed too.\nCheck each schedule.');
  const row = causeForTriggerMessage(message, () => null);
  expect([row?.label, row?.detail, row?.facts?.note]).toEqual(["Calendar", 'Review (all) "the" schedules', "Check each schedule."]);
});
