import { useThreadStatusStore } from "@/store/thread-status";

/** Whose a worker's question is now: the user's while the server lists it
 *  (its thread rests and its manager asked nothing), its manager's
 *  otherwise. The question wears yellow for the user, amber for the manager. */
export function useWorkerQuestionTone(featureId: string): "user" | "manager" {
  return useThreadStatusStore((s) => (s.waiting.some((entry) => entry.kind === "worker" && entry.featureId === featureId) ? "user" : "manager"));
}
