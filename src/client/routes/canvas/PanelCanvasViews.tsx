import { lazy, Suspense } from "react";
import { LoadingLine } from "@/components/ViewState";
import { cn } from "@/lib/utils";
import { CanvasShownContext } from "./canvas-shown";

// The canvas viewer loads with the first canvas tab, as the canvas page does
// with the first canvas opened (App.tsx).
const CanvasView = lazy(() => import("./CanvasPage").then((m) => ({ default: m.CanvasView })));

/** A panel's drawn canvas tabs (usePanelCanvasTabs' `kept`): the one shown,
 *  and the others kept as they were left, hidden and deaf to keys. */
export function PanelCanvasViews({ kept, active, onClose, openWorker }: {
  kept: readonly string[];
  active: string | null;
  onClose: (canvasId: string) => void;
  openWorker?: (featureId: string) => boolean;
}) {
  return kept.map((canvasId) => (
    <div key={canvasId} data-slot="canvas-tab-view" className={cn("min-h-0 flex-1 flex-col", canvasId === active ? "flex" : "hidden")}>
      <Suspense fallback={<div className="p-4"><LoadingLine /></div>}>
        <CanvasShownContext.Provider value={canvasId === active}>
          <CanvasView canvasId={canvasId} presentation="panel" onClose={() => onClose(canvasId)} openWorker={openWorker} />
        </CanvasShownContext.Provider>
      </Suspense>
    </div>
  ));
}
