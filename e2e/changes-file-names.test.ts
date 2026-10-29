import { expect, test } from "bun:test";
import type { BrowserContextOptions } from "playwright";
import type { FeatureChangedFileDto, FeatureChangesResponse } from "../src/shared/api-contracts";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

// Names in the Changes file list. A long name was cut mid-letter
// with no ellipsis, and its directory vanished or left one stray letter. Now
// a long name is cut in the middle with an ellipsis and keeps its end, and
// the directory takes the room left, hiding whole below four characters.
const browser = browserForFile();

const LONG_TEST = "server/http/middleware/authentication_rate_limiter_with_sliding_window_test.go";
const FITS_BARELY = "web/src/components/settings/providers/ProviderCapabilitiesEditorDialog.tsx";
const LONG_DIR = "pkg/rendering/pagecaching/cache/expiry.go";
const SHORT = "engine/planner.go";
// CJK text may break between any two characters: the kept end must not.
const CJK = "docs/界面设计规范与组件状态说明文档草稿第二版.md";
// A CJK directory beside a name that leaves it little room: its least box is
// 4ch of its own font, one character and the ellipsis.
const CJK_DIR = "目录配置组件源代码/aaaaaaaaaaaaaaaaaaaaaaa.ts";
// Twelve wide characters: a kept end about as wide as the whole row.
const WIDE_END = `web/abcde${"😀".repeat(12)}`;
const PATHS = [FITS_BARELY, LONG_TEST, LONG_DIR, SHORT, CJK, WIDE_END, CJK_DIR, "README.md"];
const files: FeatureChangedFileDto[] = PATHS.map((p, i) => ({
  path: p, oldPath: null, status: "M", additions: 12 + i * 7, deletions: i, binary: false, uncommitted: i % 2 === 0, untracked: false
}));
const list: FeatureChangesResponse = { compare: "head", baseRef: "HEAD", mergeBase: "same-head", head: "same-head", files, totalAdditions: 99, totalDeletions: 10 };
const patch = { path: LONG_DIR, truncated: false, binary: false, patch: "@@ -1,2 +1,3 @@\n package cache\n+// Evict is idempotent.\n" };

interface RowShape {
  /** The name box cut with an ellipsis: its head overflows, clips, and says so. */
  headCut: boolean;
  /** The head's box is wide enough to show its ellipsis. */
  headRoom: boolean;
  head: string;
  /** The kept end is itself cut, with its own ellipsis (only when it alone is
   *  wider than the row). */
  tailCut: boolean;
  /** The name's end, whole and in view on the row's one line, or null when
   *  the name is not split. */
  tail: string | null;
  tailInView: boolean;
  /** The row's accessible name holds the file's name unbroken. */
  named: boolean;
  /** The name (head and tail) ends inside its box: nothing clipped mid-letter. */
  nameInside: boolean;
  /** How much of the directory shows on the row's one line (0: hidden whole). */
  dirShown: number;
  dirCut: boolean;
  /** Four "0" widths (4ch) in the name's font, and in the directory's: the
   *  directory's basis, so its least box. With wide characters (CJK) that is
   *  one or two characters and the ellipsis, which is not a sliver. */
  fourCh: number;
  dirFourCh: number;
}

async function rows(options: BrowserContextOptions, url: string) {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = trackPageErrors(page);
  await page.route("**/api/features/zoom-worker/changes**", async (route) => {
    const isFile = new URL(route.request().url()).pathname.endsWith("/file");
    await route.fulfill({ json: isFile ? patch : list });
  });
  try {
    await page.goto(fixture.baseUrl + url);
    await page.locator('[data-slot="changes-tab"] button[title="README.md"]').waitFor();
    const shapes = await page.evaluate((paths) => Object.fromEntries(paths.map((p) => {
      const row = document.querySelector<HTMLElement>(`[data-slot="changes-tab"] button[title="${p}"]`)!;
      const box = row.querySelector<HTMLElement>('[data-slot="file-name"]')!.getBoundingClientRect();
      const head = row.querySelector<HTMLElement>('[data-slot="file-name-head"]')!;
      const tail = row.querySelector<HTMLElement>('[data-slot="file-name-tail"]');
      const dir = row.querySelector<HTMLElement>('[data-slot="file-dir"]');
      const end = (tail ?? head).getBoundingClientRect();
      const inside = (r: DOMRect) => r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5;
      let dirShown = 0;
      if (dir) {
        const r = dir.getBoundingClientRect();
        const onLine = r.top < box.bottom - 1 && r.bottom > box.top + 1;
        dirShown = onLine ? Math.max(0, Math.min(r.right, box.right) - Math.max(r.left, box.left)) : 0;
      }
      const fourChOf = (el: HTMLElement) => {
        const probe = document.createElement("span");
        probe.style.font = getComputedStyle(el).font;
        probe.style.whiteSpace = "pre";
        probe.textContent = "0000";
        document.body.append(probe);
        const width = probe.getBoundingClientRect().width;
        probe.remove();
        return width;
      };
      const fourCh = fourChOf(head);
      const dirFourCh = dir ? fourChOf(dir) : 0;
      const headStyle = getComputedStyle(head);
      const shape: RowShape = {
        headCut: head.scrollWidth > head.clientWidth && headStyle.textOverflow === "ellipsis" && headStyle.overflowX !== "visible",
        headRoom: head.getBoundingClientRect().width >= fourCh / 4 - 0.5,
        head: head.textContent ?? "",
        tailCut: tail ? tail.scrollWidth > tail.clientWidth && getComputedStyle(tail).textOverflow === "ellipsis" && getComputedStyle(tail).overflowX !== "visible" : false,
        tail: tail?.textContent ?? null,
        tailInView: tail ? inside(tail.getBoundingClientRect()) : false,
        nameInside: end.right <= box.right + 0.5,
        dirShown: Math.round(dirShown),
        dirCut: dir ? dir.scrollWidth > dir.clientWidth : false,
        fourCh,
        dirFourCh,
        named: false
      };
      return [p, shape];
    })), PATHS);
    const result = shapes as Record<string, RowShape>;
    // What a screen reader reads for each row: the name whole, once, and not
    // again in halves (the split's two spans read as two words).
    for (const path of PATHS) {
      const base = path.slice(path.lastIndexOf("/") + 1);
      // `- button "<name>"`, then the text content after a colon when it differs.
      const snapshot = await page.locator(`[data-slot="changes-tab"] button[title="${path}"]`).ariaSnapshot();
      const read = /^- button "((?:[^"\\]|\\.)*)"/.exec(snapshot)?.[1] ?? "";
      const rest = read.replace(base, "");
      const tail = result[path]!.tail;
      result[path]!.named = read.includes(base) && !rest.includes(base) && (tail === null || (!rest.includes(tail) && !rest.includes(result[path]!.head)));
    }
    expect(errors).toEqual([]);
    return result;
  } finally {
    await context.close();
    fixture.stop();
  }
}

/** True for every row: the name is never clipped without an ellipsis, and the
 *  directory shows at least four characters or not at all. */
function noStrayCuts(shapes: Record<string, RowShape>) {
  for (const [path, shape] of Object.entries(shapes)) {
    expect({ path, named: shape.named }).toEqual({ path, named: true });
    expect({ path, nameInside: shape.nameInside }).toEqual({ path, nameInside: true });
    expect({ path, sliver: shape.dirShown > 0 && shape.dirShown < shape.dirFourCh - 0.5 }).toEqual({ path, sliver: false });
    // A cut head shows its ellipsis: the kept end leaves it the room.
    expect({ path, ellipsisHidden: shape.headCut && !shape.headRoom }).toEqual({ path, ellipsisHidden: false });
  }
}

test("desktop: the list beside the diff cuts long names in the middle and keeps their end", async () => {
  const shapes = await rows({ viewport: { width: 1440, height: 520 } }, `${WORKER_PATH}?tab=changes&file=${encodeURIComponent(LONG_DIR)}`);
  noStrayCuts(shapes);
  for (const path of [LONG_TEST, FITS_BARELY]) {
    expect({ path, headCut: shapes[path]!.headCut, tailInView: shapes[path]!.tailInView }).toEqual({ path, headCut: true, tailInView: true });
  }
  expect(shapes[LONG_TEST]!.tail).toBe("ndow_test.go");
  // An end that fits is never cut: the head gives way first.
  expect(shapes[LONG_TEST]!.tailCut).toBe(false);
  expect(shapes[CJK]!.tailCut).toBe(false);
  expect(shapes[CJK]!.headCut).toBe(true);
  expect(shapes[CJK]!.tailInView).toBe(true);
  expect(shapes[WIDE_END]!.headCut).toBe(true);
  // A cut name leaves no room: its directory hides whole.
  expect(shapes[LONG_TEST]!.dirShown).toBe(0);
  // A short name keeps its directory, whole; a long directory is cut.
  expect(shapes[SHORT]!.dirShown).toBeGreaterThan(0);
  expect(shapes[SHORT]!.dirCut).toBe(false);
  expect(shapes[LONG_DIR]!.dirShown).toBeGreaterThanOrEqual(shapes[LONG_DIR]!.dirFourCh - 0.5);
  expect(shapes[LONG_DIR]!.dirCut).toBe(true);
}, 20_000);

test("phone: the drilled-in list keeps a name's end beside its counts, with no stray letter", async () => {
  const shapes = await rows({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true }, `${WORKER_PATH}?tab=changes`);
  noStrayCuts(shapes);
  expect(shapes[LONG_TEST]!.headCut).toBe(true);
  expect(shapes[LONG_TEST]!.tailInView).toBe(true);
  expect(shapes[LONG_TEST]!.tailCut).toBe(false);
  expect(shapes[CJK]!.tailInView).toBe(true);
  // This one fits with a few pixels to spare: too few for its directory, which
  // left a stray letter there.
  expect(shapes[FITS_BARELY]!.headCut).toBe(false);
  expect(shapes[FITS_BARELY]!.dirShown).toBe(0);
  expect(shapes[SHORT]!.dirShown).toBeGreaterThan(0);
  expect(shapes[SHORT]!.dirCut).toBe(false);
}, 20_000);

test("narrowest phone: a kept end wider than the row is cut too, never clipped bare", async () => {
  const shapes = await rows({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true }, `${WORKER_PATH}?tab=changes`);
  noStrayCuts(shapes);
  expect(shapes[WIDE_END]!.headCut).toBe(true);
  expect(shapes[WIDE_END]!.tailCut).toBe(true);
  expect(shapes[LONG_TEST]!.tailInView).toBe(true);
}, 20_000);
