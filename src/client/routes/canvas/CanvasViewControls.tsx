import { Check, Minus, Monitor, Plus } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { formatZoom } from "@/lib/desktop-zoom";
import { ZOOM_PRESETS, stepZoom, type CanvasView, type ResolvedCanvasView } from "./canvas-view";

interface CanvasViewControlsProps {
  view: CanvasView;
  resolved: ResolvedCanvasView;
  onViewChange: (view: CanvasView) => void;
}

/** The report viewer's view, as menu items: Desktop site (lay the page out at
 *  desktop width and scale it to fit), the zoom stepper, Fit width and the
 *  presets. The view half of the canvas menu, on a phone and a desktop alike. */
export function CanvasViewMenuItems({ view, resolved, onViewChange }: CanvasViewControlsProps) {
  const label = formatZoom(resolved.zoom);
  const setDesktop = (desktop: boolean) => onViewChange({ desktop, zoom: null });
  const setZoom = (zoom: number | null) => onViewChange({ ...view, zoom });
  return (
    <>
      <DropdownMenuItem role="menuitemcheckbox" aria-checked={resolved.desktop} onSelect={() => setDesktop(!resolved.desktop)}>
        <Monitor aria-hidden="true" />
        Desktop site
        {resolved.desktop && <Check aria-hidden="true" className="ml-auto" />}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <div className="flex items-center gap-1">
        <DropdownMenuItem
          aria-label="Zoom out"
          className="justify-center"
          onSelect={(event) => { event.preventDefault(); setZoom(stepZoom(resolved.zoom, -1)); }}
        >
          <Minus aria-hidden="true" />
        </DropdownMenuItem>
        <output className="flex-1 text-center text-sm font-medium tabular-nums">{label}</output>
        <DropdownMenuItem
          aria-label="Zoom in"
          className="justify-center"
          onSelect={(event) => { event.preventDefault(); setZoom(stepZoom(resolved.zoom, 1)); }}
        >
          <Plus aria-hidden="true" />
        </DropdownMenuItem>
      </div>
      {resolved.desktop && (
        <DropdownMenuItem role="menuitemradio" aria-checked={resolved.fit} onSelect={() => setZoom(null)}>
          Fit width
          {resolved.fit && <Check aria-hidden="true" className="ml-auto" />}
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <div className="grid grid-cols-3 gap-1">
        {ZOOM_PRESETS.map((preset) => {
          // Fit width is its own item; without Desktop site the default is 100%.
          const active = !(resolved.desktop && resolved.fit) && Math.abs(resolved.zoom - preset) < 0.005;
          return (
            <DropdownMenuItem
              key={preset}
              role="menuitemradio"
              aria-checked={active}
              className="justify-center tabular-nums aria-checked:bg-sel aria-checked:text-foreground aria-checked:font-semibold"
              onSelect={() => setZoom(preset)}
            >
              {formatZoom(preset)}
            </DropdownMenuItem>
          );
        })}
      </div>
    </>
  );
}
