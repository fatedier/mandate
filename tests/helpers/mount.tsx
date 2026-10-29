import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { onCleanup } from "./cleanup.js";

/**
 * Renders a client tree into a fresh host on document.body, inside act, and
 * unmounts it after the test (tests/helpers/cleanup.ts). The root is
 * registered for cleanup before it renders, so a render that throws is
 * still unmounted.
 *
 * The tree is the test's own: routers, routes and providers differ from file
 * to file. `path` is the one shortcut, for a tree that needs only a
 * MemoryRouter at that location.
 */
export interface Mounted {
  host: HTMLElement;
  /** Renders a new tree into the same root, inside act (wrapped in the same
   *  MemoryRouter when mounted with `path`). */
  rerender(node: ReactNode): void;
  /** Unmounts now; the cleanup after the test then has nothing to do. */
  unmount(): void;
}

interface MountOptions {
  /** Wraps the tree in a MemoryRouter at this location. */
  path?: string;
  /** Where the host goes, document.body when omitted: for a test whose
   *  tree must sit inside an element of its own (to see what escapes it). */
  parent?: HTMLElement;
}

function create(options: MountOptions) {
  const host = document.createElement("div");
  (options.parent ?? document.body).appendChild(host);
  const root = createRoot(host);
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    // An effect cleanup that throws surfaces here; the host still goes.
    try {
      act(() => root.unmount());
    } finally {
      host.remove();
    }
  };
  onCleanup(unmount);
  const wrap = (node: ReactNode) =>
    options.path === undefined ? node : <MemoryRouter initialEntries={[options.path]}>{node}</MemoryRouter>;
  return { host, root, wrap, unmount };
}

export function mount(node: ReactNode, options: MountOptions = {}): Mounted {
  const { host, root, wrap, unmount } = create(options);
  act(() => root.render(wrap(node)));
  return { host, rerender: (next) => act(() => root.render(wrap(next))), unmount };
}

/** mount inside an async act: effects run and the promises they start
 *  settle before it returns (a fetch on mount, a lazy chunk). */
export async function mountAsync(node: ReactNode, options: MountOptions = {}): Promise<Mounted> {
  const { host, root, wrap, unmount } = create(options);
  await act(async () => root.render(wrap(node)));
  return { host, rerender: (next) => act(() => root.render(wrap(next))), unmount };
}

/** Lets timers and promises scheduled by the tree run, inside act: a
 *  setTimeout(0) from an effect fires, a mocked fetch answers. */
export async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Lets the tree run for `rounds` turns, inside act: each turn its queued
 *  promises (a fetch answered, the state it set) and then a setTimeout(0).
 *  For work that lands across a known few hops; settleUntil when it is a
 *  condition to wait for. */
export async function settleRounds(rounds = 3): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Lets the tree run (settle) until `predicate` holds, checking between
 *  rounds: for an outcome that lands across several async hops (a router
 *  navigation, an effect that fetches), where a fixed count of settles races
 *  the machine's load. Gives up after `rounds`, naming what it waited for. */
export async function settleUntil(predicate: () => boolean, label: string, rounds = 50): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    if (predicate()) return;
    await settle();
  }
  if (predicate()) return;
  throw new Error(`settleUntil gave up: ${label}`);
}
