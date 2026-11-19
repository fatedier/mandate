import { expect, test } from "bun:test";
import { SimpleSelect } from "@/components/ui/select";
import { mount } from "../helpers/mount.js";

// An unset select: an empty value that no option holds showed an
// empty box, read as unchosen, failed or broken alike. It shows the
// placeholder; an empty value an option does hold ("Any purpose") still shows
// that option.

test("an empty value no option holds shows the placeholder, not an empty box", () => {
  const { host } = mount(
    <SimpleSelect aria-label="Model" value="" placeholder="None" options={[{ value: "team-proxy/text-embedding-3-small", label: "team-proxy/text-embedding-3-small" }]} onValueChange={() => {}} />
  );
  const trigger = host.querySelector('[data-slot="select-trigger"]')!;
  expect(trigger.textContent).toBe("None");
  expect(trigger.hasAttribute("data-placeholder")).toBe(true);
});

test("an empty value an option holds shows that option", () => {
  const { host } = mount(
    <SimpleSelect aria-label="Purpose" value="" placeholder="None" options={[{ value: "", label: "Any purpose" }, { value: "memory_dream", label: "memory_dream" }]} onValueChange={() => {}} />
  );
  const trigger = host.querySelector('[data-slot="select-trigger"]')!;
  expect(trigger.textContent).toBe("Any purpose");
  expect(trigger.hasAttribute("data-placeholder")).toBe(false);
});
