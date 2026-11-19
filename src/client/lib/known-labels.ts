import { useMemo } from "react";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useTaskBoardStore } from "@/store/task-board";

interface Labelled {
  labels: ReadonlyArray<{ name: string }>;
}

/** The label names in use on any task or thread, each once whatever its
 *  case, in the spelling met first (tasks, then open threads, then archived
 *  ones), sorted by name: what a label field suggests. */
export function knownLabels(tasks: readonly Labelled[], threads: readonly Labelled[], archived: readonly Labelled[]): string[] {
  const names = new Map<string, string>();
  for (const holder of [...tasks, ...threads, ...archived]) {
    for (const label of holder.labels) {
      const key = label.name.toLowerCase();
      if (!names.has(key)) names.set(key, label.name);
    }
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

export function useKnownLabels(): string[] {
  const tasks = useTaskBoardStore((s) => s.tasks);
  const threads = useManagerThreadsStore((s) => s.threads);
  const archived = useManagerThreadsStore((s) => s.archived);
  return useMemo(() => knownLabels(tasks ? [...tasks.values()] : [], [...threads.values()], archived), [tasks, threads, archived]);
}
