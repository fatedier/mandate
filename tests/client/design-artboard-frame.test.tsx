import { expect, test } from "bun:test";
import { DesignArtboardFrame } from "@/routes/canvas/DesignArtboardFrame";
import type { DesignBoard } from "@shared/api-contracts";
import { mountAsync } from "../helpers/mount.js";

const BOARD: DesignBoard = { path: "screens/Cart.html", x: 0, y: 0, w: 390, h: 844, title: "Cart — phone", page: "main", expand: null, interactive: true, radius: 28 };

async function render(interactive: boolean) {
  const { host } = await mountAsync(<DesignArtboardFrame canvasId="cnv_1" board={BOARD} html="<p>Cart</p>" boards={["screens/Cart.html"]} interactive={interactive} width="390px" height="844px" />);
  return host.querySelector("iframe")!;
}

test("an artboard frame is sandboxed like a report, sized, light, titled, and inert on the canvas", async () => {
  const frame = await render(false);
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox");
  expect(frame.getAttribute("title")).toBe("Cart — phone");
  expect(frame.style.width).toBe("390px");
  expect(frame.style.height).toBe("844px");
  expect(frame.style.colorScheme).toBe("light");
  expect(frame.style.pointerEvents).toBe("none");
  expect(frame.style.borderRadius).toBe("28px");
  const srcdoc = frame.getAttribute("srcdoc")!;
  expect(srcdoc).not.toContain("data-theme=");
  expect(srcdoc).toContain('<base href="http://localhost/api/canvas/cnv_1/assets/screens/" target="_blank">');
  // Its CSP admits the whole canvas folder: "../logo.png" loads.
  expect(srcdoc).toContain("img-src data: blob: http://localhost/api/canvas/cnv_1/assets/;");
});
