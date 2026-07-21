import { ArrowDown, ArrowUp, ChevronsUp, MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { useArchiveProject } from "./useArchiveProject";

interface ProjectActionsMenuProps {
  projectId: string;
  projectName: string;
  hasTmuxSession: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveToTop: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

/** Per-project overflow menu: move up / move down / archive. The move items
 *  are the reorder affordance on touch devices, where HTML5 drag-and-drop
 *  doesn't fire. Archive lives here too so the project header isn't cluttered
 *  with permanently-visible destructive buttons. */
export function ProjectActionsMenu({
  projectId,
  projectName,
  hasTmuxSession,
  canMoveUp,
  canMoveDown,
  onMoveToTop,
  onMoveUp,
  onMoveDown
}: ProjectActionsMenuProps) {
  const { archive, busy } = useArchiveProject();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          aria-label="Project actions"
          title="Project actions"
          disabled={busy}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={!canMoveUp}
          onSelect={() => { if (canMoveUp) onMoveToTop(); }}
        >
          <ChevronsUp className="h-4 w-4" />
          Move to top
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!canMoveUp}
          onSelect={() => { if (canMoveUp) onMoveUp(); }}
        >
          <ArrowUp className="h-4 w-4" />
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!canMoveDown}
          onSelect={() => { if (canMoveDown) onMoveDown(); }}
        >
          <ArrowDown className="h-4 w-4" />
          Move down
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => void archive({ projectId, projectName, hasTmuxSession })}
        >
          <Trash2 className="h-4 w-4" />
          Archive project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
