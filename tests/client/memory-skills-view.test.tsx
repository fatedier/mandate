import { expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from "react-router";
import type { LearnedSkillDetailResponse, LearnedSkillRevisionResponse, LearnedSkillsResponse, LearnedSkillSummaryDto, LearnedSkillVersionDto } from "@shared/api-contracts";
import { SkillsView } from "@/routes/memory/skills/SkillsView";
import { SkillsPane } from "@/routes/settings/SkillsPane";
import { mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle, settleUntil } from "../helpers/mount.js";
import { fakePhoneWidth } from "../helpers/fake-phone-width.js";
import { onCleanup } from "../helpers/cleanup.js";

/** Memory → Skills: the learned skills, read only — each skill, its history
 *  and every change. Changes are asked of an agent, never made here. */

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function skill(over: Partial<LearnedSkillSummaryDto> = {}): LearnedSkillSummaryDto {
  return {
    id: "skl_release", name: "release-steps", description: "Cut a release of the shop.", scope: "user", projectId: null, projectName: null,
    status: "available", archivedReason: null, revision: 2, createdAt: ago(48 * HOUR), updatedAt: ago(3 * HOUR), lastUsedAt: ago(5 * HOUR),
    uses30: 3, uses90: 7,
    createdBy: { by: "review", threadId: "thr_w", threadTitle: "cert renewal", threadKind: "worker" },
    lastChange: { by: "agent", threadId: "thr_m", threadTitle: "Bakery", threadKind: "manager", at: ago(3 * HOUR), reason: "Unsigned builds are refused.", change: "patch" },
    ...over
  };
}

const LOCAL = skill({
  id: "skl_cert", name: "cert-renewal", description: "Renew the shop's certificates.", scope: "project", projectId: "proj_tn", projectName: "bakery",
  status: "archived", archivedReason: "Not used in 60 days.", uses30: 0, uses90: 0, lastUsedAt: null,
  lastChange: { by: "rule", threadId: null, threadTitle: null, threadKind: null, at: ago(HOUR), reason: "Not used in 60 days.", change: "archive" }
});

function version(revision: number, over: Partial<LearnedSkillVersionDto> = {}): LearnedSkillVersionDto {
  return {
    revision, change: revision === 1 ? "create" : "patch", reason: revision === 1 ? "Kept the order that worked." : "Unsigned builds are refused.", at: ago((3 - revision) * HOUR + HOUR),
    name: "release-steps", description: "Cut a release of the shop.", status: "available", scope: "user", projectId: null, projectName: null, runId: null,
    by: revision === 1 ? "review" : "agent", threadId: revision === 1 ? "thr_w" : "thr_m", threadTitle: revision === 1 ? "cert renewal" : "Bakery", threadKind: revision === 1 ? "worker" : "manager",
    ...over
  };
}

const DETAIL: LearnedSkillDetailResponse = { skill: { ...skill(), body: "## Steps\n\n1. Tag.\n2. Build and sign." }, versions: [version(2), version(1)] };
const REVISIONS: Record<number, LearnedSkillRevisionResponse> = {
  2: { version: version(2), body: DETAIL.skill.body, against: 1, patch: "@@ -1,4 +1,4 @@\n ## Steps\n \n 1. Tag.\n-2. Build.\n+2. Build and sign.\n" },
  1: { version: version(1), body: "## Steps\n\n1. Tag.\n2. Build.", against: null, patch: "@@ -0,0 +1,4 @@\n+## Steps\n+\n+1. Tag.\n+2. Build.\n" }
};

/** The server: the list honours its filters as the route does. */
function serve(list: LearnedSkillSummaryDto[] = [skill(), LOCAL]) {
  return mockFetch((call) => {
    const u = new URL(call.url, "http://x");
    if (u.pathname === "/api/skills/learned") {
      const scope = u.searchParams.get("scope");
      const status = u.searchParams.get("status");
      const skills = list.filter((s) => (!status || s.status === status) && (!scope || (scope === "global" ? s.scope === "user" : s.projectId === u.searchParams.get("projectId"))));
      return Response.json({ skills, projects: [{ id: "proj_tn", name: "bakery" }] } satisfies LearnedSkillsResponse);
    }
    const revision = /^\/api\/skills\/learned\/skl_release\/revisions\/(\d+)$/.exec(u.pathname);
    if (revision) return Response.json(REVISIONS[Number(revision[1])]);
    if (u.pathname === "/api/skills/learned/skl_release") return Response.json(DETAIL);
    return new Response("not found", { status: 404 });
  });
}

let location = "";
let navigate: NavigateFunction = () => {};
function Where() {
  const at = useLocation();
  location = `${at.pathname}${at.search}`;
  navigate = useNavigate();
  return null;
}

async function view(path = "/memory?view=skills", refreshKey = 0) {
  const tree = (key: number) => (
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/memory" element={<><SkillsView refreshKey={key} /><Where /></>} /></Routes>
    </MemoryRouter>
  );
  const mounted = await mountAsync(tree(refreshKey));
  await settle(20);
  return Object.assign(mounted.host, { refresh: async (key: number) => { await mounted.rerender(tree(key)); await settle(20); } });
}
async function go(to: string) {
  await act(async () => { await navigate(to); });
  await settle(20);
}

const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-slot="skill-row"]')];
const text = (el: Element | null | undefined) => el?.textContent ?? "";
async function choose(label: string, option: string) {
  const trigger = document.querySelector<HTMLElement>(`[data-slot="select-trigger"][aria-label="${label}"]`)!;
  await act(async () => { trigger.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await settle();
  const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent === option)!;
  await act(async () => { item.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" })); item.click(); });
  await settle(20);
}
async function click(el: HTMLElement) {
  await act(async () => { el.click(); });
  await settle(20);
}

test("the list shows name, where, description, uses and last change, filtered by scope and status", async () => {
  const calls = serve();
  const host = await view();
  expect(rows(host).map((r) => text(r.querySelector('[data-slot="skill-name"]')))).toEqual(["release-steps"]);
  const row = rows(host)[0]!;
  expect(text(row.querySelector('[data-slot="skill-where"]'))).toBe("Global");
  expect(text(row)).toContain("Cut a release of the shop.");
  expect(text(row)).toContain("Uses (30 days) 3");
  expect(text(row)).toContain("Last used 5h ago");
  expect(text(row)).toContain("Changed 3h ago · Agent in Bakery");
  expect(text(host)).toContain("To change a skill, ask your agent: undo a change, go back to a revision, archive, restore or move it.");
  // Available is the start; Archived shows the others, with the project's name and the rule.
  expect(calls.map((c) => new URL(c.url, "http://x").search)).toEqual(["?status=available"]);
  await choose("Status", "Archived");
  expect(rows(host).map((r) => [text(r.querySelector('[data-slot="skill-name"]')), text(r.querySelector('[data-slot="skill-where"]'))])).toEqual([["cert-renewal", "bakery"]]);
  expect(text(rows(host)[0])).toContain("Never used");
  expect(text(rows(host)[0])).toContain("· 60-day rule");
  await choose("Scope", "Global");
  expect(rows(host).length).toBe(0);
  expect(new URL(calls.at(-1)!.url, "http://x").search).toBe("?scope=global&status=archived");
  await choose("Scope", "bakery");
  expect(new URL(calls.at(-1)!.url, "http://x").search).toBe("?scope=project&projectId=proj_tn&status=archived");
  expect(rows(host).length).toBe(1);
});

test("the empty list says how skills come", async () => {
  serve([]);
  const host = await view();
  expect(rows(host).length).toBe(0);
  expect(text(host)).toContain("No learned skills yet. They're written from finished work when an agent asks for a review; you'll be told when one is written.");
});

test("a skill opens on Skill; History lists its revisions and opens one's change", async () => {
  serve();
  const host = await view();
  await click(rows(host)[0]!.querySelector<HTMLElement>("a, button")!);
  await settleUntil(() => text(host).includes("Build and sign."), "the skill's text");
  expect(location).toBe("/memory?view=skills&skill=skl_release");
  const facts = text(host.querySelector('[data-slot="skill-facts"]'));
  for (const fact of ["Scope Global", "Revision 2", "Created by Skill review of cert renewal", "Uses (30 days) 3", "Last used 5h ago"]) expect(facts).toContain(fact);
  const tabs = [...host.querySelectorAll<HTMLElement>('[data-slot="skill-tabs"] [role="tab"], [data-slot="skill-tabs"] button')];
  expect(tabs.map((t) => text(t))).toEqual(["Skill", "History · 2"]);
  // The text is drawn as markdown: its heading is a heading.
  expect([...host.querySelectorAll("h3, h4, h5")].map((h) => h.textContent)).toContain("Steps");
  await click(tabs[1]!);
  const revs = [...host.querySelectorAll<HTMLElement>('[data-slot="skill-revision"]')];
  expect(revs.map((r) => text(r.querySelector('[data-slot="revision-head"]')))).toEqual(["Revision 2 · Agent in Bakery · 2h ago", "Revision 1 · Skill review of cert renewal · 3h ago"]);
  expect(text(revs[0])).toContain("Unsigned builds are refused.");
  // The newest is open, its change drawn as a diff.
  await settleUntil(() => text(host.querySelector('[data-slot="revision-diff"]')).includes("2. Build and sign."), "the newest revision's diff");
  await click(revs[1]!.querySelector<HTMLElement>("button")!);
  await settleUntil(() => location.endsWith("revision=1"), "the first revision opened");
  await settleUntil(() => text(host.querySelector('[data-slot="revision-diff"]')).includes("2. Build."), "the first revision's diff");
  // Back to the list.
  await click([...host.querySelectorAll<HTMLElement>("button")].find((b) => text(b) === "Skills")!);
  expect(location).toBe("/memory?view=skills");
  expect(rows(host).length).toBe(1);
});

test("a link to a revision opens History at it", async () => {
  serve();
  const host = await view("/memory?view=skills&skill=skl_release&revision=1");
  await settleUntil(() => text(host.querySelector('[data-slot="revision-diff"]')).includes("+2. Build.") || text(host.querySelector('[data-slot="revision-diff"]')).includes("2. Build."), "revision 1 open");
  const open = host.querySelector<HTMLElement>('[data-slot="skill-revision"][data-open="true"]');
  expect(text(open?.querySelector('[data-slot="revision-head"]'))).toContain("Revision 1");
});

test("on a phone the list opens a skill's page and back returns", async () => {
  onCleanup(fakePhoneWidth());
  serve();
  const host = await view();
  await click(rows(host)[0]!.querySelector<HTMLElement>("a, button")!);
  await settleUntil(() => text(host).includes("Build and sign."), "the skill's page");
  expect(rows(host).length).toBe(0);
  await click([...host.querySelectorAll<HTMLElement>("button")].find((b) => text(b) === "Skills")!);
  expect(rows(host).length).toBe(1);
});

test("a long line scrolls inside its box", async () => {
  serve();
  const host = await view("/memory?view=skills&skill=skl_release&revision=2");
  await settleUntil(() => host.querySelector('[data-slot="revision-diff"]') !== null, "the diff");
  const diff = host.querySelector<HTMLElement>('[data-slot="revision-diff"]')!;
  expect(diff.querySelector(".overflow-x-auto") !== null).toBe(true);
  expect(diff.className.split(/\s+/)).toContain("min-w-0");
});

test("Settings → Skills names where learned skills are", async () => {
  mockFetch(() => Response.json({ skills: [] }));
  const { host } = await mountAsync(<MemoryRouter><SkillsPane /></MemoryRouter>);
  await settle(20);
  expect(text(host)).toContain("Skills agents learn are on the Memory page, under Skills.");
  expect(host.querySelector('a[href="/memory?view=skills"]') !== null).toBe(true);
});

test("a link to a revision of the skill already open on Skill opens History at it", async () => {
  serve();
  const host = await view("/memory?view=skills&skill=skl_release");
  await settleUntil(() => text(host).includes("Build and sign."), "the skill");
  expect(host.querySelector('[data-slot="skill-revision"]') === null).toBe(true);
  await go("/memory?view=skills&skill=skl_release&revision=1");
  await settleUntil(() => text(host.querySelector('[data-slot="skill-revision"][data-open="true"] [data-slot="revision-head"]')).startsWith("Revision 1"), "revision 1 open");
});

test("History puts its open revision in the address; Skill takes it out", async () => {
  serve();
  const host = await view("/memory?view=skills&skill=skl_release");
  await settleUntil(() => text(host).includes("Build and sign."), "the skill");
  const tab = (label: string) => [...host.querySelectorAll<HTMLElement>('[data-slot="skill-tabs"] button')].find((b) => text(b).startsWith(label))!;
  await click(tab("History"));
  expect(location).toBe("/memory?view=skills&skill=skl_release&revision=2");
  await click(tab("Skill"));
  expect(location).toBe("/memory?view=skills&skill=skl_release");
});

test("a link to a revision newer than the history shown reads the skill again", async () => {
  let detail: LearnedSkillDetailResponse = DETAIL;
  const calls = mockFetch((call) => {
    const u = new URL(call.url, "http://x");
    if (u.pathname === "/api/skills/learned/skl_release") return Response.json(detail);
    if (u.pathname === "/api/skills/learned/skl_release/revisions/3") return Response.json({ ...REVISIONS[2]!, version: version(3), against: 2, patch: "@@ -4 +4 @@\n-2. Build and sign.\n+2. Build, sign and notarize.\n" });
    const revision = /revisions\/(\d+)$/.exec(u.pathname);
    if (revision) return Response.json(REVISIONS[Number(revision[1])]);
    return new Response("not found", { status: 404 });
  });
  const host = await view("/memory?view=skills&skill=skl_release&revision=2");
  await settleUntil(() => host.querySelector('[data-slot="revision-diff"]') !== null, "revision 2");
  detail = { skill: { ...DETAIL.skill, revision: 3 }, versions: [version(3, { reason: "Notarize too." }), version(2), version(1)] };
  await go("/memory?view=skills&skill=skl_release&revision=3");
  await settleUntil(() => text(host.querySelector('[data-slot="revision-diff"]')).includes("notarize"), "revision 3's change");
  expect(calls.filter((c) => new URL(c.url, "http://x").pathname === "/api/skills/learned/skl_release").length).toBe(2);
});

test("the page's Refresh reads the Skills view again", async () => {
  const calls = serve();
  const host = await view();
  const lists = () => calls.filter((c) => new URL(c.url, "http://x").pathname === "/api/skills/learned").length;
  expect(lists()).toBe(1);
  await host.refresh(1);
  expect(lists()).toBe(2);
});

test("a long project name stays inside its row", async () => {
  serve([{ ...LOCAL, status: "available", projectName: "a-project-with-a-name-far-longer-than-any-phone-row-is-wide" }]);
  const host = await view();
  const chip = rows(host)[0]!.querySelector<HTMLElement>('[data-slot="skill-where"]')!;
  expect(["min-w-0", "max-w-[50%]", "truncate"].every((c) => chip.classList.contains(c))).toBe(true);
  expect(chip.className.includes("shrink-0")).toBe(false);
});

test("Refresh reads an open revision's change again after it failed", async () => {
  let failing = true;
  const calls = mockFetch((call) => {
    const u = new URL(call.url, "http://x");
    if (u.pathname === "/api/skills/learned/skl_release") return Response.json(DETAIL);
    if (u.pathname === "/api/skills/learned/skl_release/revisions/2") return failing ? new Response("busy", { status: 503 }) : Response.json(REVISIONS[2]);
    return new Response("not found", { status: 404 });
  });
  const host = await view("/memory?view=skills&skill=skl_release&revision=2");
  await settleUntil(() => text(host).includes("Couldn't load the change."), "the change's error");
  failing = false;
  await host.refresh(1);
  await settleUntil(() => text(host.querySelector('[data-slot="revision-diff"]')).includes("2. Build and sign."), "the change after Refresh");
  expect(calls.filter((c) => new URL(c.url, "http://x").pathname.endsWith("/revisions/2")).length).toBe(2);
});
