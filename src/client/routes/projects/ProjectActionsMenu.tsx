import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronsUp, FolderPen, MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { useArchiveProject } from "./useArchiveProject";
import { ChangeWorkingDirDialog } from "./ChangeWorkingDirDialog";

interface ProjectActionsMenuProps {
  projectId: string;
  projectName: string;
  workingDir: string;
  /** Workers that work in the project's directory, not a worktree of their own. */
  inProjectWorkers: readonly string[];
  hasTmuxSession: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveToTop: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

/** Per-project overflow menu: move up / move down / change the working
 *  directory / archive. The move items
 *  are the reorder affordance on touch devices, where HTML5 drag-and-drop
 *  doesn't fire. Archive lives here too so the project header isn't cluttered
 *  with permanently-visible destructive buttons. */
export function ProjectActionsMenu({
  projectId,
  projectName,
  workingDir,
  inProjectWorkers,
  hasTmuxSession,
  canMoveUp,
  canMoveDown,
  onMoveToTop,
  onMoveUp,
  onMoveDown
}: ProjectActionsMenuProps) {
  const { archive, busy } = useArchiveProject();
  const [changing, setChanging] = useState(false);

  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-chrome hover:text-foreground"
          aria-label="Project actions"
          title="Project actions"
          disabled={busy}
        >
          <MoreHorizontal className="size-3.5" />
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
        <DropdownMenuItem onSelect={() => setChanging(true)}>
          <FolderPen className="h-4 w-4" />
          Change working directory…
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
    {changing && (
      <ChangeWorkingDirDialog projectId={projectId} projectName={projectName} workingDir={workingDir}
        inProjectWorkers={inProjectWorkers} onDone={() => setChanging(false)} />
    )}
    </>
  );
}
