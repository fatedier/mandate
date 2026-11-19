import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { MarkdownView } from "@/components/MarkdownView";
import { FileOpenerProvider } from "@/routes/files/FileOpenerProvider";
import { fileRoute, type FileTarget } from "@/lib/file-link";
import { runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";

// An agent's link to a file is drawn as one (an icon before its words) and a
// plain click asks the page to open it; text from the web keeps its links.

afterEach(() => { runCleanups(); });

function render(text: string, fromWeb = false) {
  const asked: FileTarget[] = [];
  const { host } = mount(
    <MemoryRouter initialEntries={["/threads/thr_a"]}>
      <FileOpenerProvider open={(t) => asked.push(t)}><MarkdownView text={text} fromWeb={fromWeb} /></FileOpenerProvider>
    </MemoryRouter>
  );
  return { host, asked };
}
const click = (el: Element | null, init: MouseEventInit = {}) => {
  expect(el === null).toBe(false);
  act(() => { (el as HTMLElement).dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })); });
};

test("a link to a file shows its words after a file icon, points at the file's page, and a click asks the page to open it", () => {
  const { host, asked } = render("The write-up is in [cache-expiry-report.md](/tmp/project-1/docs/report.md) and the cause in [expiry.ts:42](/tmp/project-1/src/expiry.ts#L42).");
  const links = [...host.querySelectorAll("a[data-file-link]")];
  expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
    ["cache-expiry-report.md", fileRoute({ path: "/tmp/project-1/docs/report.md" })],
    ["expiry.ts:42", fileRoute({ path: "/tmp/project-1/src/expiry.ts", line: 42 })]
  ]);
  expect(links.map((a) => a.querySelector('[data-slot="file-link-icon"]')?.getAttribute("data-icon"))).toEqual(["file", "file"]);
  click(links[1]!);
  expect(asked).toStrictEqual([{ path: "/tmp/project-1/src/expiry.ts", line: 42 }]);
  // With a modifier the link is the browser's: a new tab on the file's page.
  click(links[0]!, { metaKey: true });
  expect(asked).toHaveLength(1);
});

test("a file:// link and a path with spaces in angle brackets are files too", () => {
  const { host, asked } = render("See [a](file:///tmp/a%20b.md) and [b](</tmp/c d.md>).");
  const links = [...host.querySelectorAll("a[data-file-link]")];
  expect(links).toHaveLength(2);
  click(links[0]!);
  click(links[1]!);
  expect(asked).toStrictEqual([{ path: "/tmp/a b.md" }, { path: "/tmp/c d.md" }]);
});

test("an agent's image of a file is a file link with the image icon, named by its alt text", () => {
  const { host, asked } = render("Before and after: ![hit rate](/tmp/project-1/docs/shot.png)");
  expect(host.querySelector("img") === null).toBe(true);
  const link = host.querySelector("a[data-file-link]");
  expect(link?.textContent).toBe("hit rate");
  expect(link?.querySelector('[data-slot="file-link-icon"]')?.getAttribute("data-icon")).toBe("image");
  click(link);
  expect(asked).toStrictEqual([{ path: "/tmp/project-1/docs/shot.png" }]);
});

test("the app's own pages, canvases and web links stay what they were; text from the web makes no file links", () => {
  const agent = render("[Home](/home), [a canvas](/canvas/cnv_AaAaAaAaAa1), [site](https://example.com/a.md)");
  expect(agent.host.querySelectorAll("a[data-file-link]")).toHaveLength(0);
  expect(agent.host.querySelector('a[href="/home"]')).not.toBeNull();
  const web = render("[report](/tmp/report.md)", true);
  expect(web.host.querySelectorAll("a[data-file-link]")).toHaveLength(0);
});

test("a linked image keeps the link's file: one link, to where it points", () => {
  const { host, asked } = render("[![Screenshot](/tmp/thumb.png)](/tmp/shot.png)");
  const links = [...host.querySelectorAll("a[data-file-link]")];
  expect(links.map((a) => a.textContent)).toEqual(["Screenshot"]);
  click(links[0]!);
  expect(asked).toStrictEqual([{ path: "/tmp/shot.png" }]);
});
