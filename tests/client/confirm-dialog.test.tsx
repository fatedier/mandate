import { expect, test } from "bun:test";
import { act } from "react";
import { ConfirmHost } from "@/components/ConfirmDialog";
import { confirmAction } from "@/components/confirm-action";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { mountAsync, settle } from "../helpers/mount.js";

/** A menu whose item asks one question and, on a yes, a second — as the
 *  project menu's Archive asks whether to kill the tmux session too. */
function Menu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem
          onSelect={() => void (async () => {
            if (await confirmAction({ title: "Archive?", confirmLabel: "Archive" })) await confirmAction({ title: "Also kill tmux?", cancelLabel: "Keep running" });
          })()}
        >
          Archive…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("[data-confirm-dialog] button")].find((b) => b.textContent === label)!;

async function chooseArchive(host: HTMLElement) {
  const trigger = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Actions")!;
  // Radix opens a menu on pointerdown, not click.
  await act(async () => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
  // Chosen from the keyboard: the item holds focus as the question opens.
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent === "Archive…")!;
  item.focus();
  await act(async () => { item.click(); });
  return trigger;
}

test("a follow-up question asked as the first one closes gives focus back to the menu's button too", async () => {
  const { host } = await mountAsync(<><Menu /><ConfirmHost /></>);
  const trigger = await chooseArchive(host);
  await act(async () => { button("Archive").click(); });
  await settle();
  const followUp = document.querySelector("[data-confirm-dialog]");
  expect(followUp?.textContent?.includes("Also kill tmux?")).toBe(true);
  // Focus stays in the open question: the first one, closing, does not take it.
  expect(followUp?.contains(document.activeElement)).toBe(true);
  await act(async () => { button("Keep running").click(); });
  await settle();
  expect(document.activeElement === trigger).toBe(true);
});

// Radix alone gave focus back to the confirm button the dialog autofocuses,
// gone by then: focus fell to the page after every question.
test("a question asked from a plain button gives focus back to that button", async () => {
  const { host } = await mountAsync(<><button type="button" onClick={() => void confirmAction({ title: "Sure?" })}>Ask</button><ConfirmHost /></>);
  const ask = host.querySelector("button")!;
  ask.focus();
  await act(async () => { ask.click(); });
  await act(async () => { button("Cancel").click(); });
  await settle();
  expect(document.activeElement === ask).toBe(true);
});

test("a question asked with nothing focused leaves focus alone, not on an earlier question's menu button", async () => {
  const { host } = await mountAsync(<><Menu /><ConfirmHost /></>);
  const trigger = await chooseArchive(host);
  await act(async () => { button("Cancel").click(); });
  await settle();
  expect(document.activeElement === trigger).toBe(true);
  trigger.blur();
  expect(document.activeElement === document.body).toBe(true);
  await act(async () => { void confirmAction({ title: "Sure?" }); });
  await act(async () => { button("Cancel").click(); });
  await settle();
  expect(document.activeElement === trigger).toBe(false);
});
