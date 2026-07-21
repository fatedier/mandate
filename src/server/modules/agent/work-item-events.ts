import type { WorkItem } from "./work-item-store.js";

export type WorkItemChangeKind = "created" | "updated" | "deleted";

export interface WorkItemChangeEvent {
  kind: WorkItemChangeKind;
  featureId: string;
  projectId: string;
  itemId: string;
  item?: WorkItem;
  previous?: WorkItem;
  at: string;
}

export type WorkItemChangeListener = (event: WorkItemChangeEvent) => void;

export class WorkItemChangeEmitter {
  private readonly listeners = new Set<WorkItemChangeListener>();

  onChange(listener: WorkItemChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: WorkItemChangeEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Change notifications are best-effort side effects. The primary DB
        // mutation has already happened and must not be rolled back by a
        // scheduler/listener failure.
      }
    }
  }
}
