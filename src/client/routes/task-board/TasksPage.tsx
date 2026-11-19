import { useLocation, useNavigate, useParams } from "react-router";
import { useIsMobile } from "@/hooks/useIsMobile";
import { PaneHeaderTitle } from "@/shell/pane-header-slots";
import { hasAppStepBehind, OPENED_IN_APP, taskHref } from "./task-links";
import { TaskBoard } from "./TaskBoard";
import { useLabelFilterFromAddress } from "./task-open";

/** The Tasks page: the board, a task open beside it at its own address
 *  (/tasks/<id>), so a link to a task works from anywhere. */
export function TasksPage() {
  useLabelFilterFromAddress();
  const { taskId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const phone = useIsMobile();
  // On a phone the task is the whole screen: closing it goes back where the
  // owner opened it from in the app, or to the list when it was reached by
  // its address (a notification, a link from outside).
  const close = () => {
    if (phone && hasAppStepBehind(location)) void navigate(-1);
    else void navigate("/tasks", { replace: phone });
  };
  return (
    <div data-slot="tasks-page" className="flex min-h-0 w-full flex-1 flex-col">
      <PaneHeaderTitle>
        <h1 className="truncate text-sm font-semibold text-foreground">Tasks</h1>
      </PaneHeaderTitle>
      <TaskBoard selected={taskId ?? null} onSelect={(id) => { if (id) void navigate(taskHref(id), { state: OPENED_IN_APP }); else close(); }} />
    </div>
  );
}
