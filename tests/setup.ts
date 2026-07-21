import { Window } from "happy-dom";

const window = new Window({ url: "http://localhost/" });

// happy-dom injects the JS error intrinsics onto its window through a VM
// script that does not run under bun, leaving window.SyntaxError & co.
// undefined. Its selector engine constructs `new window.SyntaxError(...)`
// eagerly on every querySelector call, so without the backfill any
// querySelector — including React mounting a native <select> — crashes.
for (const key of [
  "Error",
  "TypeError",
  "SyntaxError",
  "RangeError",
  "EvalError",
  "ReferenceError",
  "URIError",
  "AggregateError"
]) {
  const target = window as unknown as Record<string, unknown>;
  if (target[key] === undefined) {
    target[key] = (globalThis as Record<string, unknown>)[key];
  }
}

function defineGlobal(key: string, value: unknown): void {
  if (key in globalThis) {
    try {
      Object.defineProperty(globalThis, key, {
        value,
        writable: true,
        configurable: true
      });
    } catch {
      // already defined and non-configurable — skip
    }
  } else {
    (globalThis as Record<string, unknown>)[key] = value;
  }
}

// DOM classes some component libraries touch at render time (e.g. Radix
// builds a DocumentFragment and observers even while closed). Only fill the
// gaps — never shadow bun's own globals (Event & co.) that server tests use.
for (const key of [
  "DocumentFragment",
  "FocusEvent",
  "HTMLAnchorElement",
  "HTMLButtonElement",
  "HTMLFormElement",
  "HTMLIFrameElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "InputEvent",
  "KeyboardEvent",
  "MouseEvent",
  "MutationObserver",
  "NodeFilter",
  "PointerEvent",
  "ResizeObserver",
  "SVGElement",
  "ShadowRoot"
]) {
  if (!(key in globalThis)) {
    (globalThis as Record<string, unknown>)[key] = (window as unknown as Record<string, unknown>)[
      key
    ];
  }
}

defineGlobal("window", window);
defineGlobal("document", window.document);
// Events dispatched onto DOM nodes must be happy-dom events, not bun's
// natives (happy-dom's dispatchEvent rejects foreign event classes). Radix
// and src/client both construct CustomEvent for DOM targets.
defineGlobal("CustomEvent", window.CustomEvent);
defineGlobal("navigator", window.navigator);
defineGlobal("HTMLElement", window.HTMLElement);
defineGlobal("Element", window.Element);
defineGlobal("Node", window.Node);
defineGlobal("getComputedStyle", window.getComputedStyle);
let animationFrameId = 0;
const animationFrameTimers = new Map<number, ReturnType<typeof setTimeout>>();
defineGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
  const id = ++animationFrameId;
  const timer = setTimeout(() => {
    animationFrameTimers.delete(id);
    cb(performance.now());
  }, 16);
  animationFrameTimers.set(id, timer);
  return id;
});
defineGlobal("cancelAnimationFrame", (id: number) => {
  const timer = animationFrameTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    animationFrameTimers.delete(id);
  }
});
defineGlobal("matchMedia", window.matchMedia.bind(window));

const realFetch = globalThis.fetch?.bind(globalThis);

defineGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  if (process.env.MANDATE_TEST_ALLOW_NETWORK === "1" && realFetch) {
    return realFetch(input, init);
  }
  throw new Error(
    `Test attempted a real network request${url ? ` to ${url}` : ""}. Mock fetch or pass an injected HTTP client instead.`
  );
});

const memory = new Map<string, string>();
defineGlobal("localStorage", {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => { memory.set(k, v); },
  removeItem: (k: string) => { memory.delete(k); },
  clear: () => memory.clear(),
  key: () => null,
  length: 0
});
