/** Marks a task opened from within the app: on a phone its Back goes back
 *  there. */
export const OPENED_IN_APP = { openedInApp: true } as const;
/** Marks a task the session opened on (a notification or a link from outside
 *  that named it on the agent's page): there is nothing of the app's behind it. */
export const OPENED_BY_ADDRESS = { openedByAddress: true } as const;

/** Whether Back on a phone goes back where the owner was: a task opened
 *  inside the app, marked so or by any step of the app's history before it
 *  (a plain link, a notification shown in a window); not one the session
 *  opened on. */
export function hasAppStepBehind(location: { state: unknown; key: string }): boolean {
  const state = typeof location.state === "object" && location.state !== null ? location.state as Record<string, unknown> : {};
  if (state.openedByAddress === true) return false;
  return state.openedInApp === true || location.key !== "default";
}

/** A task's own address: the Tasks page with the task open. */
export function taskHref(id: string): string {
  return `/tasks/${encodeURIComponent(id)}`;
}

/** The Tasks page filtered to one label (useLabelFilterFromAddress). */
export function tasksWithLabelHref(label: string): string {
  return `/tasks?${new URLSearchParams({ label }).toString()}`;
}
