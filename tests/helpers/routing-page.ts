import { act } from "react";
import { settle } from "./mount.js";

/** Readers of Settings › Routing (RoutingPane) rendered under `root`, as
 *  e2e/helpers/routing.ts reads the real page. */
export function routingPage(root: () => ParentNode) {
  const lane = (route: string) => root().querySelector<HTMLElement>(`[data-route="${route}"]`)!;
  /** A lane's step cards, in chain order. */
  const cards = (route: string) => Array.from(lane(route).querySelectorAll<HTMLButtonElement>("[data-step]"));
  const titlesOf = (route: string) => cards(route).map((card) => card.getAttribute("title"));
  /** The open step's editor, which portals into the document. */
  const editor = () => document.querySelector<HTMLElement>('[data-slot="step-editor"]');
  const button = (scope: ParentNode | null, text: string) =>
    Array.from(scope?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((b) => b.textContent?.trim() === text);
  /** A lane's row: the toggle that opens it, and what it says it runs. */
  const toggle = (route: string) => lane(route).querySelector<HTMLButtonElement>('[data-slot="section-header"] button[aria-expanded]')!;
  async function openLane(route: string) {
    if (toggle(route).getAttribute("aria-expanded") === "true") return;
    act(() => toggle(route).click());
    await settle();
  }
  const summary = (route: string) => lane(route).querySelector('[data-slot="section-summary"]')?.textContent ?? null;
  const summarySteps = (route: string) => Array.from(lane(route).querySelectorAll<HTMLElement>('[data-slot="summary-step"]'))
    .map((step) => [step.getAttribute("title"), step.querySelector('[data-slot="summary-effort"]')?.textContent ?? ""]);
  return { lane, cards, titlesOf, editor, button, toggle, openLane, summary, summarySteps };
}
