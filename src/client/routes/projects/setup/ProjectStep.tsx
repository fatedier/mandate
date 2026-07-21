import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { NewProjectDialog } from "@/routes/projects/NewProjectDialog";
import { StatusLine } from "./shared";
import type { SetupStatusResponse } from "@shared/api-contracts";

export function ProjectStep({
  hasProjects,
  status
}: {
  hasProjects: boolean;
  status: SetupStatusResponse;
}) {
  return (
    <div className="rounded-lg border border-border-soft bg-background/45 p-4">
      <StatusLine
        ready={hasProjects}
        label={hasProjects ? "Project ready" : "Create your first project"}
        detail={
          hasProjects
            ? `${status.projects.count} project${status.projects.count === 1 ? "" : "s"} available.`
            : "Name the project and point Mandate at the working directory."
        }
      />
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <NewProjectDialog />
        <Link to="/sessions">
          <Button variant="outline" size="sm">Browse tmux sessions</Button>
        </Link>
      </div>
    </div>
  );
}
