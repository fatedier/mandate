import { useEffect, useEffectEvent, useRef } from "react";

/**
 * Renders nothing. Mounted with what a fold or a Shown shows, it tells the
 * owner when that has left the page. React's development check mounts it,
 * unmounts it and mounts it again at once: that is no leave, so the call
 * waits a microtask and is dropped if it mounted again.
 */
export function WhenGone({ run }: { run: () => void }) {
  const gone = useEffectEvent(run);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (!mounted.current) gone();
      });
    };
  }, []);
  return null;
}
