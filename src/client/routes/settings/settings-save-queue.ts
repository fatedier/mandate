import { useSyncExternalStore } from "react";
import type { SettingsConfigResponse } from "./types";

/**
 * Settings' saves, one queue for the app. They go out one at a time, in the
 * order asked for, and outlive the visit to Settings that asked: leaving the
 * page does not drop a save on its way, and the next visit waits for it, says
 * it is saving, and is told when it lands.
 */

type Landed = (payload: SettingsConfigResponse, restartReason: string | undefined) => void;

let chain: Promise<unknown> = Promise.resolve();
let pending = 0;
/** Bumped by a reset (tests): a save from before it no longer counts. */
let generation = 0;
const pendingListeners = new Set<() => void>();
const landedListeners = new Set<Landed>();
/** Restart reasons of saves that landed while no visit was there to show them. */
let unclaimedRestartReasons: string[] = [];

function setPending(next: number): void {
  pending = next;
  for (const listener of pendingListeners) listener();
}

/** Queues a save; resolves with the config the server answered with, after
 *  every visit open now has been told of it. */
export function queueSettingsSave(send: () => Promise<SettingsConfigResponse>, restartReason?: string): Promise<SettingsConfigResponse> {
  const ours = generation;
  setPending(pending + 1);
  const run = chain.then(send).then((payload) => {
    if (ours !== generation) return payload;
    if (landedListeners.size === 0) {
      if (payload.restartRequired && restartReason && !unclaimedRestartReasons.includes(restartReason)) {
        unclaimedRestartReasons = [...unclaimedRestartReasons, restartReason];
      }
    } else {
      for (const listener of landedListeners) listener(payload, restartReason);
    }
    return payload;
  });
  chain = run.catch(() => undefined);
  void chain.then(() => {
    if (ours === generation) setPending(pending - 1);
  });
  return run;
}

/** Resolves once every save asked for so far has landed or failed. */
export function settingsSavesSettled(): Promise<void> {
  return chain.then(() => undefined);
}

/** Tells `listener` of each save as it lands; returns the unsubscribe. */
export function onSettingsSaveLanded(listener: Landed): () => void {
  landedListeners.add(listener);
  return () => {
    landedListeners.delete(listener);
  };
}

/** The restart reasons no visit has shown yet; taken once. */
export function takeUnclaimedRestartReasons(): string[] {
  const taken = unclaimedRestartReasons;
  unclaimedRestartReasons = [];
  return taken;
}

function subscribePending(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
}

/** Whether a save is on its way, from any visit. */
export function settingsSaving(): boolean {
  return pending > 0;
}

/** settingsSaving, as a hook that renders again when it changes. */
export function useSettingsSaving(): boolean {
  return useSyncExternalStore(subscribePending, settingsSaving, () => false);
}

/** Starts the queue afresh (tests: a save one test left on its way must not
 *  hold up or count in the next). */
export function resetSettingsSaveQueue(): void {
  generation += 1;
  chain = Promise.resolve();
  landedListeners.clear();
  unclaimedRestartReasons = [];
  setPending(0);
}
