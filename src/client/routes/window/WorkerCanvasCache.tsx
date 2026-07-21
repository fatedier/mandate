import { createContext, lazy, Suspense, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { useProjectsStore } from "@/store/projects";
import { useWorkItemsStore } from "@/store/work-items";

const FeatureCanvasTab = lazy(() => import("./FeatureCanvasTab").then((module) => ({ default: module.FeatureCanvasTab })));
const CAPACITY = 10;

interface Selection {
  featureId: string;
  canvasId: string;
}
interface Entry extends Selection {
  lastViewed: number;
}
interface Cache {
  entries: Entry[];
  active: Selection | null;
  clock: number;
}

const CanvasSelectionContext = createContext<((selection: Selection) => () => void) | null>(null);

/** The frames occupy stable DOM slots after the route content. Reparenting an
 * iframe, including moving a portal or sorting keyed slots, reloads its document. */
export function WorkerCanvasCache({ children }: { children: ReactNode }) {
  const [cache, setCache] = useState<Cache>({ entries: [], active: null, clock: 0 });
  const projects = useProjectsStore((s) => s.projects);
  const items = useWorkItemsStore((s) => s.items);
  const bindings = useMemo(() => {
    const features = new Set(projects.filter((project) => !project.archivedAt)
      .flatMap((project) => project.features.filter((feature) => !feature.archivedAt).map((feature) => feature.id)));
    return new Map([...items.values()]
      .filter((item) => features.has(item.featureId) && item.canvasId)
      .map((item) => [item.featureId, item.canvasId]));
  }, [projects, items]);

  // An archived/deleted Worker or a replaced binding must release its old frame.
  const entries = cache.entries.filter((entry) => bindings.get(entry.featureId) === entry.canvasId);
  if (entries.length !== cache.entries.length) setCache({ ...cache, entries });

  const activate = useCallback((selection: Selection) => {
    setCache((previous) => {
      const clock = previous.clock + 1;
      let entries = previous.entries.filter((entry) => entry.featureId !== selection.featureId || entry.canvasId === selection.canvasId);
      if (entries.some((entry) => entry.canvasId === selection.canvasId)) {
        entries = entries.map((entry) => entry.canvasId === selection.canvasId ? { ...selection, lastViewed: clock } : entry);
      } else {
        entries = [...entries, { ...selection, lastViewed: clock }];
      }
      if (entries.length > CAPACITY) {
        const oldest = entries.reduce((a, b) => a.lastViewed < b.lastViewed ? a : b);
        entries = entries.filter((entry) => entry !== oldest);
      }
      return { entries, active: selection, clock };
    });
    return () => setCache((previous) => previous.active === selection ? { ...previous, active: null } : previous);
  }, []);

  return (
    <CanvasSelectionContext.Provider value={activate}>
      {children}
      {entries.map((entry) => {
        const visible = cache.active?.canvasId === entry.canvasId;
        return (
          <div
            key={entry.canvasId}
            data-worker-canvas={entry.featureId}
            hidden={!visible}
            inert={!visible}
            className="w-full mx-auto max-w-[1120px] px-3 pb-3 md:px-6 md:pb-6 group-data-[pane-mode=worker]/workspace:max-w-none"
          >
            <Suspense fallback={null}>
              <FeatureCanvasTab canvasId={entry.canvasId} active={visible} />
            </Suspense>
          </div>
        );
      })}
    </CanvasSelectionContext.Provider>
  );
}

/** Selects the current Overview's Canvas without owning its DOM lifetime. */
export function ActiveWorkerCanvas({ featureId, canvasId }: Selection) {
  const activate = useContext(CanvasSelectionContext);
  useLayoutEffect(() => activate?.({ featureId, canvasId }), [activate, featureId, canvasId]);
  return null;
}
