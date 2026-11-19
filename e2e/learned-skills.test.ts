import { afterAll, beforeAll, expect, test } from "bun:test";
import type { BrowserContextOptions, Page } from "playwright";
import { startServer, type RunningServer } from "./helpers/server.js";
import { browserForFile } from "./helpers/browser.js";
import { look, trackPageErrors } from "./helpers/page-diagnostics.js";
import { pageOverflow } from "./helpers/page-overflow.js";
import { seedProject } from "../tests/helpers/fixtures.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { LearnedSkillStore } from "../src/server/modules/skills/learned-skill-store.js";

// Memory → Skills on a real server: the list, a skill's text and History,
// a revision's change, a notice's link landing on History, the review in
// Activity and Settings → Skills' line — on a desktop and on a phone, where
// nothing may widen the page.
const browser = browserForFile();
let server: RunningServer;
let release = "";
let renewal = "";

// A command line far wider than a phone, in the text and in the change.
const LONG = "openssl x509 -in /etc/kitchen/certs/main-kitchen-primary-certificate-chain.pem -noout -enddate -checkend 2592000 && systemctl reload main-kitchen.service";
const BODY_1 = `## Steps\n\n1. Tag the release.\n2. Build.\n\n\`\`\`\n${LONG}\n\`\`\``;
const BODY_2 = `## Steps\n\n1. Tag the release.\n2. Build and sign.\n\n\`\`\`\n${LONG}\n\`\`\``;
const LONG_PROJECT = "main-kitchen-certificate-rotation-for-every-branch";

beforeAll(async () => {
  server = await startServer({
    configured: true,
    seed: (dataDir) => {
      const store = new MandateStore(dataDir);
      const project = seedProject(new ProjectsStore(store.db), { name: LONG_PROJECT, tmuxSessionName: "md-skills-e2e" });
      const manager = new AgentStore(store.db).createManagerThread("Bakery");
      const skills = new LearnedSkillStore(store.db, () => new Set());
      const made = skills.create({ name: "release-steps", description: "Cut a release of the kitchen.", body: BODY_1, where: { scope: "user" }, by: "review", threadId: manager.id, reason: "Kept the order that worked." });
      if (!made.ok) throw new Error(made.message);
      release = made.skill.id;
      skills.change(release, 1, { body: BODY_2, change: "patch", by: "agent", threadId: manager.id, reason: "Unsigned builds are refused." });
      const local = skills.create({ name: "cert-renewal", description: "Renew the kitchen's certificates in every branch.", body: "1. Stop the ovens.\n2. Renew.", where: { scope: "project", projectId: project }, by: "agent", threadId: manager.id, reason: "The user asked." });
      if (!local.ok) throw new Error(local.message);
      renewal = local.skill.id;
      const run = skills.requestReview({ threadId: manager.id, requestedBy: manager.id, focus: "the release order", fromSeq: 1, toSeq: 1 });
      skills.startReview(run.id, "stub", "stub");
      skills.finishReview(run.id, { status: "succeeded", outcome: "created", skillId: release, revision: 1, reason: "Kept the order that worked." });
      // A tidy of all skills that rewrote one of them.
      const tidy = skills.startTidy("stub", "stub");
      skills.change(local.skill.id, 1, { body: "1. Stop the ovens.\n2. Renew.\n3. Start the ovens.", change: "rewrite", by: "tidy", runId: tidy.id, reason: "The ovens have to come back on." });
      skills.finishTidy(tidy.id, { status: "succeeded", changes: 1, reason: "Rewrote cert-renewal as one procedure.", changed: [{ skillId: local.skill.id, revision: 2 }] });
      // An earlier tidy that changed three skills with long names: on a phone its links wrap.
      const wide = skills.startTidy("stub", "stub");
      const names = ["main-kitchen-certificate-rotation-steps", "main-kitchen-release-coordination-steps", "main-kitchen-supplier-check-steps"];
      const wrote = names.map((name) => {
        const m = skills.create({ name, description: "A kitchen procedure.", body: "1. Look.", where: { scope: "user" }, by: "review", reason: "Created." });
        if (!m.ok) throw new Error(m.message);
        const c = skills.change(m.skill.id, 1, { body: "1. Look closely.", change: "rewrite", by: "tidy", runId: wide.id, reason: "Plainer." });
        if (!c.ok) throw new Error(c.message);
        return { skillId: c.skill.id, revision: c.skill.revision };
      });
      skills.finishTidy(wide.id, { status: "succeeded", changes: 3, reason: "Rewrote three kitchen procedures.", changed: wrote });
      store.db.close();
    }
  });
}, 60_000);
afterAll(() => server?.cleanup());

const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };

async function open(options: BrowserContextOptions, path: string) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = trackPageErrors(page);
  await page.goto(server.baseUrl + path);
  return { page, errors, close: () => context.close() };
}

const row = (page: Page, name: string) => page.locator('[data-slot="skill-row"]').filter({ hasText: name });

for (const [device, options] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test(`${device}: the list opens a skill, its History and a revision's change, and Back returns`, async () => {
    const { page, errors, close } = await open(options, "/memory");
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    await row(page, "release-steps").waitFor();
    expect(await row(page, "release-steps").textContent()).toContain("Changed");
    expect(await pageOverflow(page)).toEqual([]);
    await look(page, `skills-list-${device}`);

    await row(page, "release-steps").locator("button").click();
    await page.locator('[data-slot="skill-facts"]').waitFor();
    expect(await page.locator('[data-slot="skill-facts"]').textContent()).toContain("Created by Skill review of Bakery");
    await page.getByText("Build and sign.").waitFor();
    expect(await pageOverflow(page)).toEqual([]);
    await look(page, `skills-text-${device}`);

    await page.locator('[data-slot="skill-tabs"] button').filter({ hasText: "History" }).click();
    const diff = page.locator('[data-slot="revision-diff"]');
    await diff.getByText("2. Build and sign.").waitFor();
    expect(page.url()).toContain(`skill=${release}&revision=2`);
    expect(await pageOverflow(page)).toEqual([]);
    await look(page, `skills-history-${device}`);

    await page.goBack();
    await row(page, "release-steps").waitFor();
    expect(errors).toEqual([]);
    await close();
  });
}

test("phone: a skill of a project with a long name stays inside its row", async () => {
  const { page, close } = await open(PHONE, "/memory?view=skills");
  // Both available skills are listed, the project's long name cut.
  await row(page, "release-steps").waitFor();
  await row(page, "cert-renewal").waitFor();
  expect(await pageOverflow(page)).toEqual([]);
  const fits = await row(page, "cert-renewal").evaluate((el) => {
    const box = el.getBoundingClientRect();
    return [...el.querySelectorAll("*")].every((child) => child.getBoundingClientRect().right <= box.right + 0.5);
  });
  expect(fits).toBe(true);
  // The skill's own name keeps half the row: it is not cut for the project's.
  const nameCut = await row(page, "cert-renewal").locator('[data-slot="skill-name"]').evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(nameCut).toBe(false);
  await close();
});

test("a notice's link lands on History at its revision, in light and dark", async () => {
  const { page, errors, close } = await open(DESKTOP, `/memory?view=skills&skill=${release}&revision=1`);
  const open1 = page.locator('[data-slot="skill-revision"][data-open="true"] [data-slot="revision-head"]');
  await open1.waitFor();
  expect(await open1.textContent()).toContain("Revision 1");
  await page.locator('[data-slot="revision-diff"]').getByText("2. Build.").waitFor();
  await page.emulateMedia({ colorScheme: "light" });
  await look(page, "skills-revision-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await look(page, "skills-revision-dark");
  expect(errors).toEqual([]);
  await close();
});

test("Activity shows the review, and its link opens the skill's History", async () => {
  const { page, close } = await open(DESKTOP, "/memory?view=activity");
  const review = page.locator('[data-slot="review-event"]').first();
  await review.waitFor();
  expect(await review.locator('[data-slot="review-title"]').textContent()).toBe("Skill review of Bakery");
  await review.getByRole("link", { name: "Wrote release-steps" }).click();
  await page.locator('[data-slot="skill-revision"][data-open="true"]').waitFor();
  expect(page.url()).toContain(`skill=${release}&revision=1`);
  await close();
});

test("Activity shows the skill tidy; its link opens the revision it wrote, authored Skill tidy; on a phone it stays inside the page, light and dark", async () => {
  for (const [device, options] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
    for (const colorScheme of ["light", "dark"] as const) {
      const { page, errors, close } = await open({ ...options, colorScheme }, "/memory?view=activity");
      const tidy = page.locator('[data-slot="tidy-event"]').filter({ hasText: "Rewrote cert-renewal as one procedure." });
      await tidy.waitFor();
      expect(await tidy.locator('[data-slot="review-title"]').textContent()).toBe("Skill tidy");
      expect(await pageOverflow(page)).toEqual([]);
      await look(page, `skills-tidy-${device}-${colorScheme}`);
      if (device === "desktop" && colorScheme === "light") {
        await tidy.getByRole("link", { name: "Changed cert-renewal" }).click();
        const open = page.locator('[data-slot="skill-revision"][data-open="true"]');
        await open.waitFor();
        expect(page.url()).toContain(`skill=${renewal}&revision=2`);
        expect(await open.locator('[data-slot="revision-head"]').textContent()).toContain("Skill tidy");
      }
      expect(errors).toEqual([]);
      await close();
    }
  }
}, 60_000);

test("phone: a tidy's links that wrap keep their touch areas apart", async () => {
  const { page, close } = await open(PHONE, "/memory?view=activity");
  const tidy = page.locator('[data-slot="tidy-event"]').filter({ hasText: "Rewrote three kitchen procedures." });
  await tidy.waitFor();
  const boxes = await tidy.locator('[data-slot="review-state"]').evaluateAll((links) => links.map((l) => l.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom })));
  expect(boxes.length).toBe(3);
  const rows = [...new Set(boxes.map((b) => Math.round(b.top)))];
  expect(rows.length).toBeGreaterThan(1);
  // A touch area is 44 px tall round each link: the rows sit far enough apart.
  for (let i = 1; i < boxes.length; i++) {
    const [above, below] = [boxes[i - 1]!, boxes[i]!];
    if (Math.round(below.top) === Math.round(above.top)) continue;
    const reach = (b: { top: number; bottom: number }) => Math.max(0, (44 - (b.bottom - b.top)) / 2);
    expect(below.top - reach(below)).toBeGreaterThanOrEqual(above.bottom + reach(above) - 0.5);
  }
  await close();
});

test("Settings → Skills says where learned skills are, and links there", async () => {
  const { page, close } = await open(DESKTOP, "/settings?tab=skills");
  await page.getByText("Skills agents learn are on the").waitFor();
  await page.getByRole("link", { name: "Memory page, under Skills" }).click();
  await row(page, "release-steps").waitFor();
  await close();
});
