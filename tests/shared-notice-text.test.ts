import { expect, test } from "bun:test";
import { channelNoticeText, noticeLines, systemNoticeText } from "../src/shared/notice-text.js";
import { AGENT_QUESTION_MATTER, TASK_REVIEW_LEAD } from "../src/shared/api/notifications.js";

// An in-app notice is one short lead and one line under it: what the user is
// asked, or what the task is, not the message it came from.

const ask = (body: string) => noticeLines({ key: AGENT_QUESTION_MATTER, title: "Juno asks", body });

test("a question shows the sentence that asks, without its context or its markdown", () => {
  expect(ask("!12 合并了：提交是 `abc1234`，我核过 `src/orders` 下的文件。这次只改订单页，菜单页不用动。要发布订单页吗（先发测试环境）？"))
    .toEqual({ lead: "Juno asks", line: "要发布订单页吗（先发测试环境）？" });
  expect(ask("I merged **!34** after the review. Should I deploy it to staging?").line).toBe("Should I deploy it to staging?");
  // The last asking sentence, when there are two.
  expect(ask("Is the branch right? I rebased it. Shall I push it now?").line).toBe("Shall I push it now?");
});

test("a question mark inside a link or an address is not where a sentence ends", () => {
  expect(ask("The run is at https://ci.example.test/runs?id=42 and it passed. Merge [!34](https://git.example.test/mr?tab=diff)?").line)
    .toBe("Merge !34?");
});

// A command in backticks is part of the question, its dots and marks too.
test("marks inside inline code do not end the asking sentence", () => {
  expect(ask("Do you want me to run `git add .` before committing?").line).toBe("Do you want me to run git add . before committing?");
  expect(ask("Can I run `cd ..` and retry the build?").line).toBe("Can I run cd .. and retry the build?");
  expect(ask("I staged the files. Shall I run `npm test -- --watch=false`? It takes a minute.").line).toBe("Shall I run npm test -- --watch=false?");
  expect(ask("我已经暂存了。要我先跑 `git add .` 再提交吗？").line).toBe("要我先跑 git add . 再提交吗？");
});

// A period after an abbreviation, or before a word in lower case, ends no
// sentence: when the end is unsure the line keeps more, never less.
test("abbreviations do not end the asking sentence", () => {
  expect(ask("Should I update the docs, e.g. README and CONTRIBUTING?").line).toBe("Should I update the docs, e.g. README and CONTRIBUTING?");
  expect(ask("Should I deploy it to the U.S. region?").line).toBe("Should I deploy it to the U.S. region?");
  expect(ask("The build passed. Should I ship it, i.e. tag and push?").line).toBe("Should I ship it, i.e. tag and push?");
  // "etc." before a capital may or may not end a sentence: the line keeps both.
  expect(ask("Fixed lint, tests etc. Should I push?").line).toBe("Fixed lint, tests etc. Should I push?");
  expect(ask("I checked the logs. Should I restart it?").line).toBe("Should I restart it?");
});

test("a question with no question mark shows its whole text, on one line", () => {
  expect(ask("Pick one of the two plans:\n\n- A\n- B").line).toBe("Pick one of the two plans: A B");
});

test("a task ready for review leads with that, and the task's title is the line", () => {
  expect(noticeLines({ key: "task:tsk_1", title: `${TASK_REVIEW_LEAD}: Add a gluten-free filter to the menu`, body: "The filter is on the menu page." }))
    .toEqual({ lead: TASK_REVIEW_LEAD, line: "Add a gluten-free filter to the menu" });
});

test("any other notice keeps its title, and its text loses its markdown", () => {
  expect(noticeLines({ key: "thread:thr_a", title: "Docs move is done", body: "Every **guide** moved;\nthe `links` were checked." }))
    .toEqual({ lead: "Docs move is done", line: "Every guide moved; the links were checked." });
});

// A system notification shows two or three lines: a question's asking
// sentence comes first there, then the whole message on one line for what it
// is about (the system cuts what it cannot show). A channel such as Telegram
// has room: the asking sentence, then the message as written.
test("a question's system notification and its channel text lead with the sentence that asks", () => {
  const body = "I rebased the branch on `main`.\n\n- **Tests**: all pass.\n\nShall I push it now?";
  const question = { key: AGENT_QUESTION_MATTER, body };
  expect(systemNoticeText(question)).toBe("Shall I push it now? I rebased the branch on main. Tests: all pass. Shall I push it now?");
  expect(channelNoticeText(question)).toBe(`Shall I push it now?\n\n${body}`);
});

test("a question that is only its asking sentence is said once", () => {
  const question = { key: AGENT_QUESTION_MATTER, body: "Shall I push **it** now?" };
  expect(systemNoticeText(question)).toBe("Shall I push it now?");
  expect(channelNoticeText(question)).toBe("Shall I push **it** now?");
});

test("other notices keep their text as it came", () => {
  const notice = { key: "thread:thr_a", body: "The manager asks.\n\nWhether **staging** is fine?" };
  expect(systemNoticeText(notice)).toBe(notice.body);
  expect(channelNoticeText(notice)).toBe(notice.body);
});
