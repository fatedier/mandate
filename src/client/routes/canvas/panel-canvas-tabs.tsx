import { useEffect, useState } from "react";
import { FileText, LayoutGrid } from "lucide-react";
import type { PanelTabItem } from "@/components/PanelTabRow";
import { canvasIdOfTab } from "@/lib/panel-tabs";
import { useCanvasTitles } from "@/store/canvas-titles";
import type { CanvasUpdatedPayload } from "@shared/api-contracts";

/** A right panel's canvas tabs (a thread's, Your agent's): each one's tab,
 *  named by its canvas's title and kind (read with the others wanted now,
 *  "Canvas" until then, read again when the canvas changes), and the canvases drawn — each from the first time
 *  its tab shows, and kept while it is open, so a tab switched back to is as
 *  it was left; one never shown (remembered from before) is not read. */
export function usePanelCanvasTabs(tabIds: readonly string[], active: string, close: (tabId: string) => void): {
  items: ReadonlyMap<string, PanelTabItem>;
  kept: string[];
  activeCanvas: string | null;
} {
  const titles = useCanvasTitles((s) => s.titles);
  const canvasIds = tabIds.map(canvasIdOfTab).filter((id): id is string => id !== null);
  const activeCanvas = canvasIdOfTab(active);
  useEffect(() => {
    for (const id of canvasIds) useCanvasTitles.getState().want(id);
  });
  // A canvas changed may have a new name: its tab reads it again, as its bar does.
  const tabCanvases = canvasIds.join(",");
  useEffect(() => {
    const ids = new Set(tabCanvases.split(","));
    const onUpdate = (event: Event) => {
      const id = (event as CustomEvent<CanvasUpdatedPayload>).detail?.canvasId;
      if (id && ids.has(id)) useCanvasTitles.getState().refresh(id);
    };
    window.addEventListener("mandate:canvas-updated", onUpdate);
    return () => window.removeEventListener("mandate:canvas-updated", onUpdate);
  }, [tabCanvases]);
  const [drawn, setDrawn] = useState<ReadonlySet<string>>(() => new Set());
  if (activeCanvas && !drawn.has(activeCanvas)) setDrawn(new Set(drawn).add(activeCanvas));
  const items = new Map<string, PanelTabItem>();
  for (const id of tabIds) {
    const canvasId = canvasIdOfTab(id);
    if (!canvasId) continue;
    const known = titles.get(canvasId);
    const Icon = known?.kind === "design" ? LayoutGrid : FileText;
    items.set(id, {
      id,
      label: known?.title ?? "Canvas",
      icon: <Icon aria-hidden className="size-3.5 shrink-0" />,
      onClose: () => close(id),
      dataCanvasTab: canvasId
    });
  }
  return { items, kept: canvasIds.filter((id) => drawn.has(id) || id === activeCanvas), activeCanvas };
}
