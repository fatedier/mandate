import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { Section, SectionLink, SectionRow } from "@/components/Section";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null; let host: HTMLElement | null = null;
function reset() { act(() => root?.unmount()); host?.remove(); root = null; host = null; }
afterEach(reset);

function render(node: React.ReactNode) {
  host = document.createElement("div"); document.body.appendChild(host);
  act(() => { root = createRoot(host!); root.render(<MemoryRouter>{node}</MemoryRouter>); });
  return host!;
}

test("a section is a 32px header line followed by one panel", () => {
  const el = render(
    <Section title="Calls" meta="last 30 days" trailing={<SectionLink to="/activity?tab=logs">Open logs</SectionLink>}>
      <SectionRow>row one</SectionRow>
      <SectionRow>row two</SectionRow>
    </Section>
  );
  const section = el.querySelector("section")!;
  const header = section.querySelector('[data-slot="section-header"]')!;
  const panel = section.querySelector('[data-slot="section-panel"]')!;
  expect(header === null).toBe(false);
  for (const t of ["flex", "h-8", "items-center", "gap-2"]) expect(header.className.split(/\s+/)).toContain(t);
  expect(header.textContent).toContain("Calls");
  expect(header.querySelector('[data-slot="section-meta"]')!.textContent).toBe("last 30 days");
  expect(header.querySelector('[data-slot="section-meta"]')!.className.split(/\s+/)).toContain("text-faint");
  expect(panel === null).toBe(false);
  for (const t of ["rounded-lg", "border-border-soft", "bg-panel", "overflow-hidden"]) expect(panel.className.split(/\s+/)).toContain(t);
  expect(el.innerHTML.includes("bg-card")).toBe(false);
  expect(header.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const rows = panel.querySelectorAll('[data-slot="section-row"]');
  expect(rows.length).toBe(2);
  for (const r of rows) for (const t of ["border-t", "border-border-soft", "first:border-t-0", "px-3.5"]) expect(r.className.split(/\s+/)).toContain(t);
  const link = header.querySelector("a")!;
  expect(link.getAttribute("href")).toBe("/activity?tab=logs");
  expect(link.className.split(/\s+/)).toContain("text-muted-foreground");
  expect(link.querySelector("svg") === null).toBe(false);
});

test("a section is its own container, cannot be pushed wider than its column, and drops only the meta narrow", () => {
  const el = render(<Section title="Calls" meta="last 30 days"><div>a</div></Section>);
  const section = el.querySelector("section")!;
  for (const t of ["@container", "min-w-0"]) expect(section.className.split(/\s+/)).toContain(t);
  expect(section.querySelector('[data-slot="section-title"]')!.className.split(/\s+/)).toContain("whitespace-nowrap");
  expect(section.querySelector('[data-slot="section-meta"]')!.className.split(/\s+/)).toContain("@max-[34rem]:hidden");
  expect(section.querySelector('[data-slot="section-header"]')!.className.split(/\s+/)).toContain("h-8");
});

test("subheader is a second line between the header and the panel", () => {
  const el = render(<Section title="x" subheader={<div data-sub="1">picker</div>}><div>a</div></Section>);
  const header = el.querySelector('[data-slot="section-header"]')!;
  const sub = el.querySelector('[data-sub="1"]')!;
  const panel = el.querySelector('[data-slot="section-panel"]')!;
  expect(sub === null).toBe(false);
  expect(header.compareDocumentPosition(sub) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(sub.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(header.contains(sub)).toBe(false);
  expect(panel.contains(sub)).toBe(false);
});

test("panel={false} renders the children bare under the header; no bg-card anywhere", () => {
  const el = render(<Section title="Grid" panel={false}><div data-x="1">a</div></Section>);
  expect(el.querySelector('[data-slot="section-panel"]') === null).toBe(true);
  expect(el.querySelector('[data-x="1"]') === null).toBe(false);
  expect(el.querySelector('[data-slot="section-meta"]') === null).toBe(true);
  expect(el.innerHTML.includes("bg-card")).toBe(false);
});

test("Section meta treats false and empty string as absent but renders 0", () => {
  const withFalse = render(<Section title="x" meta={false}><div>a</div></Section>);
  expect(withFalse.querySelector('[data-slot="section-meta"]') === null).toBe(true);
  reset();
  const withEmpty = render(<Section title="x" meta=""><div>a</div></Section>);
  expect(withEmpty.querySelector('[data-slot="section-meta"]') === null).toBe(true);
  reset();
  const withZero = render(<Section title="x" meta={0}><div>a</div></Section>);
  expect(withZero.querySelector('[data-slot="section-meta"]')!.textContent).toBe("0");
});

test("SectionRow minH picks the row height token", () => {
  const el = render(<Section title="x"><SectionRow minH="52">a</SectionRow><SectionRow>b</SectionRow></Section>);
  const rows = el.querySelectorAll('[data-slot="section-row"]');
  expect(rows[0]!.className.split(/\s+/)).toContain("min-h-13");
  expect(rows[1]!.className.split(/\s+/)).toContain("min-h-10");
});
