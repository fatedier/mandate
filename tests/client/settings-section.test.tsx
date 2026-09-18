import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SectionFooterState } from "@/routes/settings/settings-config";
import { SettingsSection } from "@/routes/settings/SettingsSection";

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(node: ReactNode): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

function stubFooter(overrides: Partial<SectionFooterState> = {}): SectionFooterState {
  return { dirty: false, saving: false, error: "", justSaved: false, onSave: () => {}, ...overrides };
}

/** The panel under the header line — the surface that carries the dirty frame. */
function card(c: HTMLElement): HTMLElement {
  const el = c.querySelector('[data-slot="section-panel"]');
  if (!el) throw new Error("expected the section panel to render");
  return el as HTMLElement;
}

function saveButton(c: HTMLElement): HTMLButtonElement {
  const button = c.getElementsByTagName("button")[0];
  if (!button) throw new Error("expected the footer Save button");
  return button as unknown as HTMLButtonElement;
}

function spanContaining(c: HTMLElement, text: string): HTMLElement {
  const span = Array.from(c.getElementsByTagName("span")).find((el) =>
    (el.textContent ?? "").includes(text)
  );
  if (!span) throw new Error(`expected a span containing "${text}"`);
  return span as unknown as HTMLElement;
}

/** SettingsSection is the visual save-unit shell on the list language: a 32px
 *  header line (title · description as meta · restart pill · trailing slot)
 *  over ONE bg-panel hairline panel holding the body, with a footer row that
 *  only exists while its SectionFooterState has something to say
 *  (dirty/saving/error/justSaved). These tests pin the footer's state machine
 *  and the panel's dirty frame. */
describe("SettingsSection", () => {
  test("renders title, description, headerSlot and children; no footer prop means no footer ever", () => {
    const c = render(
      <SettingsSection title="General" description="Core behavior" headerSlot={<span>SLOT</span>}>
        <div>FIELDS</div>
      </SettingsSection>
    );
    const h3 = c.getElementsByTagName("h3")[0];
    if (!h3) throw new Error("expected the section h3 title");
    expect(h3.textContent).toBe("General");
    expect(h3.className).toContain("text-xs");
    expect(h3.className).toContain("font-semibold");
    expect(h3.getAttribute("data-slot")).toBe("section-title");
    const header = c.querySelector('[data-slot="section-header"]')!;
    expect(header === null).toBe(false);
    for (const t of ["flex", "h-8", "items-center"]) expect(header.className.split(/\s+/)).toContain(t);
    // The panel is the redesign's list surface, not the old rounded card.
    for (const t of ["rounded-lg", "border-border-soft", "bg-panel"]) expect(card(c).className.split(/\s+/)).toContain(t);
    for (const t of ["rounded-xl", "bg-card", "border-primary/45", "border-status-review/45"]) expect(card(c).className.split(/\s+/)).not.toContain(t);
    // The description is the header line's meta, and it lives in the header,
    // not inside the panel.
    const meta = spanContaining(c, "Core behavior");
    expect(meta.getAttribute("data-slot")).toBe("section-meta");
    expect(meta.className).toContain("text-faint");
    expect(header.contains(meta)).toBe(true);
    expect(card(c).contains(meta)).toBe(false);
    // The header slot is the header line's trailing control, after the spacer.
    expect(header.textContent).toContain("SLOT");
    expect(card(c).textContent).not.toContain("SLOT");
    expect(c.textContent).toContain("SLOT");
    expect(c.textContent).toContain("FIELDS");
    // Read-only section: no pill, no footer, no Save button.
    expect(c.textContent).not.toContain("restart on change");
    expect(c.getElementsByTagName("button").length).toBe(0);
  });

  test("restartPill renders the review-toned pill", () => {
    const c = render(
      <SettingsSection title="Server" restartPill>
        <div />
      </SettingsSection>
    );
    const pill = spanContaining(c, "restart on change");
    expect(pill.className).toContain("text-status-review");
    expect(pill.className).toContain("border-status-review/35");
    expect(pill.className).toContain("rounded-full");
  });

  test("collapse: the header is a 44px row inside the panel; closed, the panel is that row alone", () => {
    let toggles = 0;
    const c = render(
      <SettingsSection title="kilo" collapse={{ open: false, onToggle: () => { toggles += 1; } }} rows>
        <div>FIELDS</div>
      </SettingsSection>
    );
    // No outside header line: the group is a list item, not a section.
    const headers = Array.from(c.querySelectorAll('[data-slot="section-header"]'));
    expect(headers).toHaveLength(1);
    expect(card(c).contains(headers[0]!)).toBe(true);
    expect(headers[0]!.className.split(/\s+/)).toContain("min-h-11");
    const toggle = c.querySelector("button[aria-expanded]")!;
    expect(toggle === null).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(c.textContent).not.toContain("FIELDS");
    act(() => { (toggle as HTMLButtonElement).click(); });
    expect(toggles).toBe(1);
    // Open: the body follows the row under a hairline.
    const o = render(
      <SettingsSection title="kilo" collapse={{ open: true, onToggle: () => {} }} rows>
        <div>FIELDS</div>
      </SettingsSection>
    );
    expect(o.textContent).toContain("FIELDS");
    expect(o.querySelector("button[aria-expanded]")!.getAttribute("aria-expanded")).toBe("true");
  });

  test("idle footer state renders no footer", () => {
    const c = render(
      <SettingsSection title="General" footer={stubFooter()}>
        <div />
      </SettingsSection>
    );
    expect(c.getElementsByTagName("button").length).toBe(0);
    expect(c.textContent).not.toContain("Unsaved changes");
    expect(card(c).className).not.toContain("border-status-review/45");
  });

  test("dirty: footer appears with the unsaved note, the needs-you frame, and a live Save button", () => {
    let saves = 0;
    const c = render(
      <SettingsSection title="General" footer={stubFooter({ dirty: true, onSave: () => { saves += 1; } })}>
        <div />
      </SettingsSection>
    );
    // A frame means "wants you": the dirty panel borrows the attention colour.
    expect(card(c).className.split(/\s+/)).toContain("border-status-review/45");
    expect(card(c).className).not.toContain("border-primary");
    const note = spanContaining(c, "Unsaved changes");
    expect(note.className).toContain("text-muted-foreground");
    // The dirty marker is a styled dot, not a ● glyph — a text character's box
    // and baseline are font-dependent, so it can't be optically centred against
    // the label. Assert the dot element rather than a character.
    const dot = Array.from(note.getElementsByTagName("span")).find((el) =>
      el.className.includes("rounded-full")
    );
    if (!dot) throw new Error("expected the dirty dot");
    expect(dot.className).toContain("bg-status-review");
    const button = saveButton(c);
    expect(button.textContent).toBe("Save");
    expect(button.disabled).toBe(false);
    // 28px, like every control on a list surface; the footer is the panel's
    // last row, inside it, under a hairline.
    expect(button.className.split(/\s+/)).toContain("h-7");
    const footer = button.parentElement!;
    expect(card(c).contains(footer)).toBe(true);
    expect(footer.className.split(/\s+/)).toContain("border-t");
    act(() => {
      button.click();
    });
    expect(saves).toBe(1);
  });

  test("saving: button reads Saving… and is disabled", () => {
    const c = render(
      <SettingsSection title="General" footer={stubFooter({ dirty: true, saving: true })}>
        <div />
      </SettingsSection>
    );
    const button = saveButton(c);
    expect(button.textContent).toBe("Saving…");
    expect(button.disabled).toBe(true);
  });

  test("disabled: Save button is locked but keeps the Save label (pane-level lock)", () => {
    let saves = 0;
    const c = render(
      <SettingsSection
        title="General"
        footer={stubFooter({ dirty: true, disabled: true, onSave: () => { saves += 1; } })}
      >
        <div />
      </SettingsSection>
    );
    const button = saveButton(c);
    expect(button.textContent).toBe("Save");
    expect(button.disabled).toBe(true);
    act(() => {
      button.click();
    });
    expect(saves).toBe(0);
  });

  test("error replaces the dirty note", () => {
    const c = render(
      <SettingsSection
        title="General"
        footer={stubFooter({ dirty: true, error: "Port must be a number" })}
      >
        <div />
      </SettingsSection>
    );
    const errorSpan = spanContaining(c, "Port must be a number");
    expect(errorSpan.className).toContain("text-destructive");
    expect(c.textContent).not.toContain("Unsaved changes");
  });

  test("justSaved: footer stays with the Saved confirmation", () => {
    const c = render(
      <SettingsSection title="General" footer={stubFooter({ justSaved: true })}>
        <div />
      </SettingsSection>
    );
    // "Saved" plus a check icon — the ✓ glyph it replaced could not be sized or
    // aligned against the label the way an icon can.
    const saved = spanContaining(c, "Saved");
    expect(saved.className).toContain("text-live");
    expect(saved.getElementsByTagName("svg").length).toBe(1);
    expect(saveButton(c).textContent).toBe("Save");
  });
});
