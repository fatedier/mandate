import { ArrowUpRight, FileText, LayoutGrid, MoreHorizontal, Trash2 } from "lucide-react";
import { useOpenCanvas } from "@/routes/canvas/canvas-opener";
import { RelativeTime } from "@/components/RelativeTime";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { InlineError, LoadingLine } from "@/components/ViewState";
import { deleteCanvasAfterConfirm } from "@/routes/canvas/delete-canvas";
import type { FeatureCanvasesState } from "./use-feature-canvases";

/** The feature's canvases: every report and design scoped to it — what the
 *  agent wrote, task_complete outputs — each opening in the fullscreen modal.
 *  The caller holds the fetch, so the plan's canvas links and the Canvases
 *  tab share one. */
export function FeatureCanvasList({ state }: { state: FeatureCanvasesState }) {
  const { canvases, error } = state;
  const open = useOpenCanvas();

  if (error) {
    return <InlineError className="py-2" detail={error} onRetry={() => state.retry()}>Couldn't load canvases.</InlineError>;
  }

  if (!canvases) return <LoadingLine className="py-2" />;

  if (canvases.length === 0) {
    return (
      <p data-slot="canvas-empty" className="m-0 py-2 text-xs text-faint">
        No canvases yet. Reports and designs the agent makes for this feature show up here.
      </p>
    );
  }

  return (
    <ul data-slot="canvas-list" className="overflow-hidden rounded-lg border border-border-soft bg-panel">
      {canvases.map((canvas) => {
        const kind = canvas.kind === "design" ? "Design" : "Report";
        return (
          <li key={canvas.id} data-slot="canvas-row" className="flex items-center border-t border-border-soft first:border-t-0">
            <button
              type="button"
              onClick={() => open(canvas.id)}
              className="group flex h-13 min-w-0 flex-1 items-center gap-3 pl-3.5 pr-1.5 text-left transition-colors hover:bg-sel"
              aria-label={`Open ${kind.toLowerCase()}: ${canvas.title}`}
            >
              {canvas.kind === "design"
                ? <LayoutGrid className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                : <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 truncate text-xs font-medium text-foreground">{canvas.title}</span>
                </span>
                <span className="mt-0.5 block text-2xs text-faint">
                  <span data-slot="canvas-kind">{kind}</span> · Updated <RelativeTime value={canvas.updatedAt} />
                </span>
              </span>
              <ArrowUpRight className="size-3.5 shrink-0 text-faint transition-colors group-hover:text-foreground" aria-hidden />
            </button>
            {/* Always shown: a phone has no hover to reveal it. On a touch
                screen its 44px area reaches 6px past it, kept off the row. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="mr-2 text-chrome hover:text-foreground pointer-coarse:ml-1.5" aria-label={`Canvas actions: ${canvas.title}`}>
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => void deleteCanvasAfterConfirm({ id: canvas.id, title: canvas.title, featureId: state.featureId })}
                >
                  <Trash2 aria-hidden="true" />
                  Delete canvas…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        );
      })}
    </ul>
  );
}
