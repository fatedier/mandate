import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Presence } from "radix-ui/internal";
import { cn } from "@/lib/utils";
import { WhenGone } from "./WhenGone";

/**
 * What comes and goes with a move each way: the question over the composer,
 * the chat's working line. While `when`, it shows its children, moving in by
 * `enter` when `when` turns true, or as it mounts with `appear`: what was
 * there as the page opened does not move in. Once `when` turns false it keeps
 * the children it last showed, out of reach (inert), while `exit` runs (Radix
 * Presence waits for it to end), then drops them and calls `onGone`. Focus in
 * it as it starts to leave goes by `onFocusOut` first, while it can still be
 * moved. Asked for less motion, neither runs (globals.css) and it goes at
 * once.
 */
export function Shown({ when, appear = false, enter, exit, className, onGone, onFocusOut, children }: {
  when: boolean;
  appear?: boolean;
  enter: string;
  exit: string;
  className?: string;
  onGone?: () => void;
  onFocusOut?: () => void;
  children: ReactNode;
}) {
  const [enters, setEnters] = useState(!when || appear);
  if (!when && !enters) setEnters(true);
  const ref = useRef<HTMLDivElement>(null);
  const focusOut = useEffectEvent(() => onFocusOut?.());
  // Mounted with nothing to show: nothing to leave, so it is gone at once.
  const [mountedEmpty] = useState(!when);
  const goneAtOnce = useEffectEvent(() => onGone?.());
  useEffect(() => { if (mountedEmpty) goneAtOnce(); }, [mountedEmpty]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!when && el.contains(document.activeElement)) focusOut();
    el.inert = !when;
  }, [when]);
  return (
    <Presence.Presence present={when}>
      <div ref={ref} data-slot="shown" className={cn(className, when ? enters && enter : exit)}>
        <LastShown shown={when}>{children}</LastShown>
        {onGone && <WhenGone run={onGone} />}
      </div>
    </Presence.Presence>
  );
}

/** Its children while `shown`; once not, the children it last showed, so
 *  what leaves leaves as it was. */
export function LastShown({ shown, children }: { shown: boolean; children: ReactNode }) {
  const [last, setLast] = useState(children);
  if (shown && last !== children) setLast(children);
  return shown ? children : last;
}
