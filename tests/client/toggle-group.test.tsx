import { expect, test } from "bun:test";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { mount } from "../helpers/mount.js";

// The chosen item reads as chosen: the selection fill and body text, the
// others in chrome — the grammar the pill tabs use. The accent fill it had is
// the panel's own colour give or take a shade.
test("the chosen item has the selection fill and body text; the others are chrome", () => {
  const { host } = mount(
    <ToggleGroup type="single" value="dark" variant="outline" size="sm">
      <ToggleGroupItem value="system">System</ToggleGroupItem>
      <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
      <ToggleGroupItem value="light">Light</ToggleGroupItem>
    </ToggleGroup>
  );
  const items = [...host.querySelectorAll<HTMLElement>("[data-slot=toggle-group-item]")];
  expect(items.map((item) => item.getAttribute("data-state"))).toEqual(["off", "on", "off"]);
  for (const item of items) {
    const tokens = item.className.split(/\s+/);
    expect(tokens).toContain("text-chrome");
    expect(tokens).toContain("data-[state=on]:bg-sel");
    expect(tokens).toContain("data-[state=on]:text-foreground");
    expect(tokens.some((t) => t.includes("accent"))).toBe(false);
  }
});
