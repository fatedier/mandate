import type { WakeFinishedEvent } from "../modules/agent/wake-loop.js";
import type { LifecycleSseEventName, SseEventPayloadMap } from "../../shared/api-contracts.js";
import { logError } from "../platform/logger.js";

type LifecycleEventType = LifecycleSseEventName;

export type LifecycleEvent = {
  [K in LifecycleEventType]: {
    type: K;
    data: SseEventPayloadMap[K];
  }
}[LifecycleEventType];

export type LifecyclePublisher = (event: LifecycleEvent) => void;

export type AppEvent =
  | { type: "lifecycle"; event: LifecycleEvent }
  | { type: "agent.wakeFinished"; event: WakeFinishedEvent };

type AppEventType = AppEvent["type"];
type AppEventFor<T extends AppEventType> = Extract<AppEvent, { type: T }>;
type Handler<T extends AppEventType> = (event: AppEventFor<T>) => void | Promise<void>;
type AnyHandler = (event: AppEvent) => void | Promise<void>;

export class AppEventBus {
  private handlers = new Map<AppEventType, Set<AnyHandler>>();

  on<T extends AppEventType>(type: T, handler: Handler<T>): () => void {
    let handlers = this.handlers.get(type);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(type, handlers);
    }
    const anyHandler = handler as unknown as AnyHandler;
    handlers.add(anyHandler);
    return () => {
      handlers?.delete(anyHandler);
      if (handlers?.size === 0) this.handlers.delete(type);
    };
  }

  emit(event: AppEvent): void {
    const handlers = this.handlers.get(event.type);
    if (!handlers) return;
    for (const handler of Array.from(handlers)) {
      try {
        const result = handler(event);
        if (result && typeof result.then === "function") {
          void result.catch((err) => {
            logError(`event-bus ${event.type}`, err, "event handler failed");
          });
        }
      } catch (err) {
        logError(`event-bus ${event.type}`, err, "event handler failed");
      }
    }
  }
}
