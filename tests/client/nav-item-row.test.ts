import { describe, expect, test } from "bun:test";
import { act, createElement, type ComponentProps, type ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { House } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { NavItemRow } from "@/shell/NavItemRow";
import { mount } from "../helpers/mount.js";

function render(node: ReactNode): HTMLElement {
  return mount(createElement(MemoryRouter, null, node)).host;
}

function firstAnchor(c: HTMLElement): HTMLAnchorElement {
  const anchor = c.getElementsByTagName("a")[0];
  if (!anchor) throw new Error("expected an anchor in the rendered row");
  return anchor as unknown as HTMLAnchorElement;
}

const homeItem = { to: "/projects", label: "Home", icon: House };

/** NavItemRow is shared by the desktop sidebar and mobile nav sheet. The
 *  structurally fragile part is the sidebar's collapsed mode, where a Radix
 *  Tooltip wraps the row via `asChild`: the Slot's props/ref must spread
 *  through NavItemRow onto the Link's anchor or tooltips silently die
 *  (typecheck cannot catch it). These tests pin that wiring plus the row's
 *  onNavigate/variant behavior. */
describe("NavItemRow", () => {
  test("collapsed row inside Tooltip asChild: trigger props land on the anchor", () => {
    const c = render(
      createElement(
        TooltipProvider,
        {} as ComponentProps<typeof TooltipProvider>,
        createElement(
          Tooltip,
          null,
          createElement(
            TooltipTrigger,
            { asChild: true },
            createElement(NavItemRow, {
              item: homeItem,
              active: true,
              target: "/projects",
              collapsed: true
            })
          ),
          createElement(TooltipContent, { side: "right" }, "Home")
        )
      )
    );
    const anchor = firstAnchor(c);
    // The row's own classes survived the Slot className merge
    expect(anchor.className).toContain("size-9");
    expect(anchor.className).toContain("active");
    expect(anchor.className).toContain("relative");
    expect(anchor.getAttribute("aria-label")).toBe("Home");
    expect(anchor.getAttribute("aria-current")).toBe("page");
    expect(anchor.getAttribute("href")).toBe("/projects");
    // Radix trigger props spread through NavItemRow onto the DOM node
    expect(anchor.getAttribute("data-slot")).toBe("tooltip-trigger");
    expect(anchor.getAttribute("data-state")).toBe("closed");
  });

  test("expanded row: link click fires onNavigate", () => {
    let navigated = 0;
    const c = render(
      createElement(NavItemRow, {
        item: homeItem,
        active: false,
        target: "/projects",
        onNavigate: () => { navigated += 1; }
      })
    );
    const anchor = firstAnchor(c);
    expect(anchor.className).toContain("h-[30px] w-full");
    expect(navigated).toBe(0);

    act(() => {
      anchor.click();
    });
    expect(navigated).toBe(1);
  });

});
