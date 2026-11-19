import { useCallback, useEffect, useLayoutEffect } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { useTaskBoardStore } from "@/store/task-board";
import { OPENED_BY_ADDRESS, OPENED_IN_APP, taskHref } from "./task-links";

/** The address that opens a task in the personal agent's panel, from anywhere. */
export const agentTaskHref = (id: string) => `/agent?task=${encodeURIComponent(id)}`;

const onTasksPage = (pathname: string) => pathname === "/tasks" || pathname.startsWith("/tasks/");

/**
 * Opens a task where it belongs from here: on the Tasks page, there; on the
 * agent's page, in a tab of its own in the panel; anywhere else, on the
 * agent's page with the task named in the address. A phone opens it full screen.
 */
export function useOpenTask(): (id: string) => void {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const phone = useIsMobile();
  return useCallback((id: string) => {
    if (phone || onTasksPage(pathname)) void navigate(taskHref(id), { state: OPENED_IN_APP });
    else if (pathname === "/agent") useAgentPageUi.getState().openTask(id);
    else void navigate(agentTaskHref(id));
  }, [navigate, pathname, phone]);
}

/** On the Tasks page: `?label=<name>` filters the board to that label alone,
 *  in place of the filters this browser kept, then leaves the address: a
 *  project's page links its tasks so. The filter is set before the first
 *  paint, the address left after it, as useProjectFilterFromAddress does. */
export function useLabelFilterFromAddress(): void {
  const [params, setParams] = useSearchParams();
  const label = params.get("label");
  useLayoutEffect(() => {
    if (label) useTaskBoardStore.setState({ filters: { labels: [label], due: [] } });
  }, [label]);
  useEffect(() => {
    if (label === null) return;
    const next = new URLSearchParams(params);
    next.delete("label");
    setParams(next, { replace: true });
    // The param is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);
}

/** On the agent's page: `?task=<id>` opens that task in the panel, then
 *  leaves the address, as a thread's page does with `?worker=`. */
export function useTaskFromAddress(): void {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const phone = useIsMobile();
  const taskId = params.get("task");
  useEffect(() => {
    if (!taskId) return;
    // A phone has no panel: the task opens full screen, in this address's
    // place. Back from it goes where this address was reached from, or to
    // the list when the session opened on it.
    if (phone) {
      void navigate(taskHref(taskId), { replace: true, state: location.key === "default" ? OPENED_BY_ADDRESS : OPENED_IN_APP });
      return;
    }
    useAgentPageUi.getState().openTask(taskId);
    const next = new URLSearchParams(params);
    next.delete("task");
    setParams(next, { replace: true });
    // The param is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);
}
