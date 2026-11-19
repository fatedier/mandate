import { expect, test } from "bun:test";
import { act } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { mountAsync, settle } from "../helpers/mount.js";

function Menu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Refresh</DropdownMenuItem>
        <DropdownMenuItem>Rename</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const key = (el: Element, name: string) => act(async () => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
});
const menuOpen = () => document.querySelector('[role="menu"]') !== null;
const item = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent === name)!;

async function openFromKeyboard() {
  const { host } = await mountAsync(<Menu />);
  const trigger = host.querySelector("button")!;
  trigger.focus();
  await key(trigger, "Enter");
  await settle();
  expect(menuOpen()).toBe(true);
  return trigger;
}

test("an item chosen from the keyboard gives focus back to the menu's button", async () => {
  const trigger = await openFromKeyboard();
  const refresh = item("Refresh");
  refresh.focus();
  await key(refresh, "Enter");
  await settle();
  expect(menuOpen()).toBe(false);
  expect(document.activeElement === trigger).toBe(true);
});

// Radix focuses the trigger from script, which Chrome's focus-visible
// heuristic draws as a keyboard focus: after a click a ring stayed on the
// trigger until a second click elsewhere.
test("an item chosen with the pointer leaves focus off the menu's button", async () => {
  const { host } = await mountAsync(<Menu />);
  const trigger = host.querySelector("button")!;
  // Radix opens a menu on pointerdown, not click.
  await act(async () => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
  await settle();
  const refresh = item("Refresh");
  await act(async () => {
    refresh.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    refresh.click();
  });
  await settle();
  expect(menuOpen()).toBe(false);
  expect(document.activeElement === trigger).toBe(false);
});

test("an item clicked after moving through the menu with the keys leaves focus off the menu's button", async () => {
  const trigger = await openFromKeyboard();
  await key(document.activeElement ?? document.body, "ArrowDown");
  const rename = item("Rename");
  await act(async () => {
    rename.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    rename.click();
  });
  await settle();
  expect(menuOpen()).toBe(false);
  expect(document.activeElement === trigger).toBe(false);
});

test("after a menu closed from the keyboard, the next one opened and dismissed with the pointer leaves focus off its button", async () => {
  const trigger = await openFromKeyboard();
  await key(document.activeElement ?? document.body, "Escape");
  await settle();
  expect(document.activeElement === trigger).toBe(true);
  await act(async () => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
  await settle();
  expect(menuOpen()).toBe(true);
  // Outside the menu: it closes, with no key pressed in it this time.
  await act(async () => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
  await settle();
  expect(menuOpen()).toBe(false);
  expect(document.activeElement === trigger).toBe(false);
});

// Opened from the keyboard, the menu moves focus into itself in an effect, a
// moment after it shows: an Esc pressed by then lands on the button.
test("an Esc that closes the menu before focus has moved into it still gives focus back to its button", async () => {
  const trigger = await openFromKeyboard();
  await key(trigger, "Escape");
  await settle();
  expect(menuOpen()).toBe(false);
  expect(document.activeElement === trigger).toBe(true);
});

// The highlighted item shows in both themes: the selection fill and body text.
// The accent it had is the popover's own colour give or take a shade in the
// dark theme (#232326 on #26262a), so a hovered or arrowed-to item was
// invisible there. Select and context menu items read the same.
test("a highlighted item takes the selection fill, not the accent", async () => {
  await openFromKeyboard();
  const tokens = item("Refresh").className.split(/\s+/);
  expect(tokens).toContain("focus:bg-sel");
  expect(tokens).toContain("focus:text-foreground");
  expect(tokens.some((t) => t.includes("accent"))).toBe(false);
});
