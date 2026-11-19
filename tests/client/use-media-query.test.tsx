import { afterEach, expect, test } from "bun:test";
import { act, Activity } from "react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { fakePhoneWidth } from "../helpers/fake-phone-width.js";
import { mount } from "../helpers/mount.js";

afterEach(() => { runCleanups(); });

function Probe() {
  return <p data-slot="probe">{useMediaQuery("(max-width: 767px)") ? "phone" : "desktop"}</p>;
}

// A page kept while another shows (shell/KeptPage) hears no change while it
// is hidden: shown again, it reads the window as it is now.
test("a query read in a hidden page is read again when the page shows", () => {
  const view = mount(<Activity mode="visible"><Probe /></Activity>);
  const said = () => view.host.querySelector('[data-slot="probe"]')?.textContent;
  expect(said()).toBe("desktop");
  act(() => { view.rerender(<Activity mode="hidden"><Probe /></Activity>); });
  onCleanup(fakePhoneWidth());
  act(() => { view.rerender(<Activity mode="visible"><Probe /></Activity>); });
  expect(said()).toBe("phone");
});
