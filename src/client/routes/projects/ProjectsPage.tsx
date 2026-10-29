import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { useProjectsStore } from "@/store/projects";
import { NewProjectDialog } from "@/routes/projects/NewProjectDialog";
import { ProjectSection } from "@/routes/projects/ProjectSection";
import { PaneHeaderActions } from "@/shell/pane-header-slots";
import { LoadingLine, StateAction, StateMessage } from "@/components/ViewState";
import { useProjectsArrival } from "@/hooks/useProjectsArrival";

function swapProjectId(projectIds: string[], projectId: string, direction: 1 | -1): string[] | null {
  const idx = projectIds.indexOf(projectId);
  if (idx < 0) return null;
  const swap = idx + direction;
  if (swap < 0 || swap >= projectIds.length) return null;
  const next = [...projectIds];
  [next[idx], next[swap]] = [next[swap]!, next[idx]!];
  return next;
}

function sendProjectToTop(projectIds: string[], projectId: string): string[] | null {
  const idx = projectIds.indexOf(projectId);
  if (idx <= 0) return null;
  const next = [...projectIds];
  const [item] = next.splice(idx, 1);
  if (!item) return null;
  next.unshift(item);
  return next;
}

export function ProjectsPage() {
  const projects = useProjectsStore((s) => s.projects);
  const reorderProjects = useProjectsStore((s) => s.reorderProjects);
  const reordering = useProjectsStore((s) => s.reordering);
  const arrival = useProjectsArrival();


  function moveProject(projectId: string, direction: 1 | -1) {
    const nextIds = swapProjectId(projects.map((project) => project.id), projectId, direction);
    if (nextIds) void reorderProjects(nextIds);
  }

  function moveProjectToTop(projectId: string) {
    const nextIds = sendProjectToTop(projects.map((project) => project.id), projectId);
    if (nextIds) void reorderProjects(nextIds);
  }

  const column = "mx-auto flex w-full max-w-[1040px] flex-col gap-7 px-4 pt-1 pointer-coarse:pt-2 pb-6 md:px-8";
  // Before the projects arrive, none is not yet "No projects yet".
  if (arrival !== "loaded") {
    return (
      <div className={column}>
        {arrival === "late" ? (
          <StateMessage title="Couldn't load projects" heading="h1" action={<StateAction onClick={() => window.location.reload()}>Retry</StateAction>}>
            The list of projects hasn't arrived from Mandate. Check that it's running.
          </StateMessage>
        ) : <LoadingLine />}
      </div>
    );
  }

  return (
    <div className={column}>
      {projects.length === 0 && (
        <div className="rounded-lg border border-border-soft bg-panel p-4 md:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">No projects yet</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                Add one with New project.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="outline" asChild>
                <Link to="/settings">Settings</Link>
              </Button>
              <NewProjectDialog />
            </div>
          </div>
        </div>
      )}
      {projects.length > 0 && (
        <>
          <PaneHeaderActions>
            <NewProjectDialog triggerVariant="outline" triggerSize="xs" />
          </PaneHeaderActions>
          <div className="flex flex-col gap-7">
            {projects.map((project, index) => (
              <ProjectSection
                key={project.id}
                project={project}
                canMoveUp={!reordering && index > 0}
                canMoveDown={!reordering && index < projects.length - 1}
                onMoveToTop={() => moveProjectToTop(project.id)}
                onMoveUp={() => moveProject(project.id, -1)}
                onMoveDown={() => moveProject(project.id, 1)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
