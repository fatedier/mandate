/**
 * Polls `condition` until it returns something truthy, and returns that.
 * For a test waiting on something outside React (a server, a socket, a
 * store) — inside a mounted tree use settleUntil (tests/helpers/mount.tsx),
 * which lets React commit between checks. A wait that runs out throws,
 * naming what it waited for, so a real failure reads as one. A label given
 * as a function is read then, so it can report what was seen instead (the
 * diff a loop's closing assertion used to show).
 *
 * The deadline holds throughout: a truthy answer counts only if it comes by
 * the deadline (an async condition that stalls, or any condition that turns
 * truthy only after it, is a timeout), and the pause between polls never runs
 * past it.
 */
export async function waitUntil<T>(
  condition: () => T | Promise<T>,
  { timeout = 5000, interval = 20, label = "condition" }: { timeout?: number; interval?: number; label?: string | (() => string) } = {}
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  const timedOut = (): Error => {
    let named: string;
    let cause: unknown;
    try {
      named = typeof label === "function" ? label() : label;
    } catch (error) {
      // The timeout is what the reader needs; a label that broke must not hide it.
      cause = error;
      named = `(its label failed: ${error instanceof Error ? error.message : String(error)})`;
    }
    return new Error(`waitUntil timed out after ${timeout}ms: ${named}`, cause === undefined ? undefined : { cause });
  };
  const late = Symbol("late");
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const value = await Promise.race([
      Promise.resolve().then(condition),
      new Promise<typeof late>((resolve) => { timer = setTimeout(() => resolve(late), Math.max(0, deadline - Date.now())); })
    ]).finally(() => clearTimeout(timer));
    if (value === late) throw timedOut();
    // A truthy answer counts only if it came in time, however it was reached.
    if (value) {
      if (Date.now() > deadline) throw timedOut();
      return value as NonNullable<T>;
    }
    const left = deadline - Date.now();
    if (left <= 0) throw timedOut();
    // The pause never outlasts the deadline; one last check runs at it.
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval, left)));
  }
}
