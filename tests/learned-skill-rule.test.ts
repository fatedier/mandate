import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LearnedSkillStore } from "../src/server/modules/skills/learned-skill-store.js";
import { createUnusedSkillsRule } from "../src/server/modules/skills/learned-skill-rule.js";
import type { NotifyOutcome, NotifyRequest } from "../src/server/modules/notifications/notification-service.js";
import { testStore } from "./helpers/test-store.js";

const opened: Array<() => void> = [];
afterEach(() => { while (opened.length) opened.pop()!(); });
const DAY = 86_400_000;

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-skill-rule-"));
  const store = testStore(dir);
  let clock = Date.parse("2026-09-01T08:00:00.000Z");
  const now = () => new Date(clock);
  const skills = new LearnedSkillStore(store.db, () => new Set(), now);
  const sent: NotifyRequest[] = [];
  // What the notifications answer: sent unless a test says there is no channel.
  const answers: NotifyOutcome[] = [];
  const notify = async (n: NotifyRequest): Promise<NotifyOutcome> => {
    const answer = answers.shift() ?? { line: "Sent." };
    if (!answer.notSent) sent.push(n);
    return answer;
  };
  const rule = createUnusedSkillsRule({ store: skills, notify, now });
  const restarted = () => createUnusedSkillsRule({ store: skills, notify, now });
  opened.push(() => { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const make = (name: string) => {
    const made = skills.create({ name, description: "x", body: "1. x", where: { scope: "user" }, by: "review" });
    if (!made.ok) throw new Error(made.message);
    return made.skill;
  };
  return { skills, rule, restarted, sent, answers, make, tick: (ms: number) => { clock += ms; } };
}

test("the 60-day rule runs once a day: that day's first check archives what is due and sends one notice; later checks that day do nothing", async () => {
  const t = fresh();
  t.make("old-steps");
  t.make("older-steps");
  t.tick(61 * DAY);
  await t.rule.tick();
  expect(t.skills.list({ where: { scope: "user" } }).map((s) => s.status)).toEqual(["archived", "archived"]);
  expect(t.sent.map((n) => n.title)).toEqual(["2 unused skills archived"]);
  t.make("late-steps");
  t.tick(60 * 60_000);
  await t.rule.tick();
  expect(t.sent).toHaveLength(1);
});

test("a day with nothing due sends nothing", async () => {
  const t = fresh();
  t.make("fresh-steps");
  t.tick(DAY);
  await t.rule.tick();
  expect(t.sent).toEqual([]);
});

test("a restart later the same day archives nothing more and sends no second notice", async () => {
  const t = fresh();
  const HOUR = 60 * 60_000;
  t.make("old-steps");
  t.tick(6 * HOUR);
  const later = t.make("later-steps");
  // The day's first check: only the first is due.
  t.tick(60 * DAY - 3 * HOUR);
  await t.rule.tick();
  // Four hours on the second is due too, and the server restarts.
  t.tick(4 * HOUR);
  await t.restarted().tick();
  expect(t.sent.map((n) => n.title)).toEqual(["1 unused skill archived"]);
  expect(t.skills.get(later.id)?.status).toBe("available");
});

test("a notice with no channel to go to is kept and sent on a later check", async () => {
  const t = fresh();
  t.make("old-steps");
  t.tick(61 * DAY);
  t.answers.push({ line: "Not sent: no channel is set up.", notSent: "no_channel" });
  await t.rule.tick();
  expect(t.sent).toEqual([]);
  t.tick(60_000);
  await t.rule.tick();
  expect(t.sent.map((n) => [n.title, n.text])).toEqual([["1 unused skill archived", "old-steps"]]);
  t.tick(60_000);
  await t.rule.tick();
  expect(t.sent).toHaveLength(1);
});
