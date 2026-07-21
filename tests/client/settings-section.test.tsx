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

function card(c: HTMLElement): HTMLElement {
  const el = c.firstElementChild;
  if (!el) throw new Error("expected the section card to render");
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

/** SettingsSection is the visual save-unit shell: card + header (+ optional
 *  restart pill / header slot) + body, with a footer that only exists while
 *  its SectionFooterState has something to say (dirty/saving/error/justSaved).
 *  These tests pin the footer's state machine and the card's dirty border. */
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
    expect(h3.className).toContain("text-sm");
    expect(h3.className).toContain("font-semibold");
    expect(card(c).className).toContain("rounded-xl");
    expect(card(c).className).toContain("bg-card");
    expect(card(c).className).not.toContain("border-primary/45");
    expect(spanContaining(c, "Core behavior").className).toContain("text-chrome");
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

  test("idle footer state renders no footer", () => {
    const c = render(
      <SettingsSection title="General" footer={stubFooter()}>
        <div />
      </SettingsSection>
    );
    expect(c.getElementsByTagName("button").length).toBe(0);
    expect(c.textContent).not.toContain("Unsaved changes");
    expect(card(c).className).not.toContain("border-primary/45");
  });

  test("dirty: footer appears with the unsaved note, primary border, and a live Save button", () => {
    let saves = 0;
    const c = render(
      <SettingsSection title="General" footer={stubFooter({ dirty: true, onSave: () => { saves += 1; } })}>
        <div />
      </SettingsSection>
    );
    expect(card(c).className).toContain("border-primary/45");
    const note = spanContaining(c, "Unsaved changes");
    expect(note.className).toContain("text-muted-foreground");
    // The dirty marker is a styled dot, not a ● glyph — a text character's box
    // and baseline are font-dependent, so it can't be optically centred against
    // the label. Assert the dot element rather than a character.
    const dot = Array.from(note.getElementsByTagName("span")).find((el) =>
      el.className.includes("rounded-full")
    );
    if (!dot) throw new Error("expected the dirty dot");
    expect(dot.className).toContain("bg-primary");
    const button = saveButton(c);
    expect(button.textContent).toBe("Save");
    expect(button.disabled).toBe(false);
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
