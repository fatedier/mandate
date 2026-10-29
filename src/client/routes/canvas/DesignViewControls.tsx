import { Check, ChevronDown, ChevronLeft, ChevronRight, Layers, LayoutGrid, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { formatZoom } from "@/lib/desktop-zoom";
import { DESIGN_ZOOM_PRESETS, stepDesignZoom } from "./design-camera";
import { designShowsPages, type DesignViewer } from "./use-design-viewer";

/** The design viewer's controls: pages and zoom in the canvas's
 *  header; when focused, the artboard's place, previous/next and Fit/100%,
 *  in a bar of their own under the header (a phone has no room beside Close). */
export function DesignViewControls({ viewer }: { viewer: DesignViewer }) {
  if (viewer.focused) {
    const count = viewer.boards.length;
    const title = viewer.focused.title ?? viewer.focused.path;
    const zoomLabel = viewer.focusZoom === "fit" ? "Fit" : "100%";
    return (
      <>
        <Button variant="outline" size="sm" onClick={viewer.unfocus} aria-label="All artboards">
          <LayoutGrid aria-hidden="true" />
          <span className="hidden sm:inline">All artboards</span>
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={title}>{title}</span>
        <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{viewer.focusIndex + 1} / {count}</span>
        <Button variant="ghost" size="icon-sm" onClick={viewer.prev} disabled={viewer.focusIndex <= 0} aria-label="Previous artboard"><ChevronLeft /></Button>
        {/* 12px from Previous on a touch screen: two 32px icons' 44px touch areas meet, not overlap. */}
        <Button variant="ghost" size="icon-sm" onClick={viewer.next} disabled={viewer.focusIndex >= count - 1} aria-label="Next artboard" className="pointer-coarse:ml-1"><ChevronRight /></Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" aria-label={`Zoom, ${zoomLabel}`}>{zoomLabel}<ChevronDown aria-hidden="true" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            {(["fit", "actual"] as const).map((zoom) => (
              <DropdownMenuItem key={zoom} role="menuitemradio" aria-checked={viewer.focusZoom === zoom} onSelect={() => viewer.setFocusZoom(zoom)}>
                {zoom === "fit" ? "Fit" : "100%"}
                {viewer.focusZoom === zoom && <Check aria-hidden="true" className="ml-auto" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    );
  }

  const page = viewer.pages.find((p) => p.id === viewer.page);
  const label = formatZoom(viewer.camera.z);
  return (
    <>
      {designShowsPages(viewer) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" aria-label={`Page, ${page?.name ?? ""}`}>
              <Layers aria-hidden="true" />
              <span className="hidden max-w-32 truncate sm:inline">{page?.name}</span>
              <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DesignPageMenuItems viewer={viewer} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" aria-label={`Zoom, ${label}`} className="tabular-nums">{label}<ChevronDown aria-hidden="true" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DesignZoomMenuItems viewer={viewer} />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/** The page menu's items. Also part of a phone's canvas menu. */
export function DesignPageMenuItems({ viewer }: { viewer: DesignViewer }) {
  return (
    <>
      {viewer.pages.map((p) => (
        <DropdownMenuItem key={p.id} role="menuitemradio" aria-checked={p.id === viewer.page} onSelect={() => viewer.setPage(p.id)}>
          <span className="truncate">{p.name || p.id}</span>
          {p.id === viewer.page && <Check aria-hidden="true" className="ml-auto" />}
        </DropdownMenuItem>
      ))}
    </>
  );
}

/** The zoom menu's items: the stepper, Fit all and the presets. Also part of
 *  a phone's canvas menu. */
export function DesignZoomMenuItems({ viewer }: { viewer: DesignViewer }) {
  const label = formatZoom(viewer.camera.z);
  return (
    <>
      <div className="flex items-center gap-1">
        <DropdownMenuItem aria-label="Zoom out" className="justify-center" onSelect={(event) => { event.preventDefault(); viewer.zoomTo(stepDesignZoom(viewer.camera.z, -1)); }}><Minus aria-hidden="true" /></DropdownMenuItem>
        <output className="flex-1 text-center text-sm font-medium tabular-nums">{label}</output>
        <DropdownMenuItem aria-label="Zoom in" className="justify-center" onSelect={(event) => { event.preventDefault(); viewer.zoomTo(stepDesignZoom(viewer.camera.z, 1)); }}><Plus aria-hidden="true" /></DropdownMenuItem>
      </div>
      <DropdownMenuItem role="menuitemradio" aria-checked={viewer.fitted} onSelect={viewer.fitAll}>
        Fit all
        {viewer.fitted && <Check aria-hidden="true" className="ml-auto" />}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <div className="grid grid-cols-3 gap-1">
        {DESIGN_ZOOM_PRESETS.map((preset) => {
          const active = !viewer.fitted && Math.abs(viewer.camera.z - preset) < 0.005;
          return (
            <DropdownMenuItem key={preset} role="menuitemradio" aria-checked={active} className="justify-center tabular-nums aria-checked:bg-sel aria-checked:text-foreground aria-checked:font-semibold" onSelect={() => viewer.zoomTo(preset)}>
              {formatZoom(preset)}
            </DropdownMenuItem>
          );
        })}
      </div>
    </>
  );
}
