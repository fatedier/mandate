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

/** A publisher that hands each lifecycle event to `deliver` (the
 *  broadcaster); a failure there is logged, never thrown into the code that
 *  published the event. */
export function publishTo(deliver: (event: LifecycleEvent) => void): LifecyclePublisher {
  return (event) => {
    try {
      deliver(event);
    } catch (err) {
      logError(`lifecycle ${event.type}`, err, "event delivery failed");
    }
  };
}
