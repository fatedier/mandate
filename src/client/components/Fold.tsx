import { useCallback, useEffect, useRef, type AnimationEvent, type ComponentProps, type RefObject } from "react";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import { WhenGone } from "./WhenGone";

type FoldProps = {
  open: boolean;
  /** Called once its content has left the page: when its close animation
   *  ends, or at once when there is none to run. */
  onClosed?: () => void;
} & Omit<ComponentProps<typeof CollapsiblePrimitive.Content>, "ref" | "onAnimationStart" | "onAnimationEnd">;

/**
 * What a disclosure shows while open: it grows in and out on its measured
 * height (Radix Collapsible sets it; the fold keyframes in globals.css move
 * it and fade it, clipping only while it moves) instead of popping, and its
 * content is out of the page while shut. Its owner keeps the open state and
 * its own toggle (with aria-expanded). The owner's class goes on a box
 * inside, so its padding and border shrink with it; without one, the fold
 * adds no box around the content. Asked for less motion, it opens and closes
 * at once (globals.css).
 */
export function Fold({ open, className, children, onClosed, ...props }: FoldProps) {
  const grow = useGrowToContent();
  return (
    // asChild: the root is the content element itself, so the fold adds no
    // element around what it shows (a "next to the button" rule still holds).
    <CollapsiblePrimitive.Root open={open} asChild>
      <CollapsiblePrimitive.Content
        data-slot="fold"
        className="data-[state=open]:animate-fold-open data-[state=closed]:animate-fold-close"
        {...props}
        {...grow}
      >
        {className ? <div className={className}>{children}</div> : children}
        {onClosed && <WhenGone run={onClosed} />}
      </CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}

/**
 * Radix measures the height a fold opens to once, as it starts; content that
 * arrives while it grows (steps read on open) would end in a jump. While its
 * open animation runs, the height it grows to follows its content each frame
 * (`--fold-height`, read by the fold-open keyframes before Radix's measure).
 * It stops when that animation ends or is cancelled (less motion asked for
 * on its way): React has no animationcancel handler, so a listener of its own.
 */
function useGrowToContent() {
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const stop = (el: HTMLElement) => stopFollowing(frame, el);
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const cancelled = (event: Event) => { if (event.target === el) stopFollowing(frame, el); };
    el.addEventListener("animationcancel", cancelled);
    return () => el.removeEventListener("animationcancel", cancelled);
  }, []);
  return {
    ref,
    onAnimationStart: (event: AnimationEvent<HTMLDivElement>) => {
      // A nested fold's animation bubbles up here; it is not this one's.
      if (event.target !== event.currentTarget) return;
      const el = event.currentTarget;
      stop(el);
      if (event.animationName !== "fold-open") return;
      const follow = () => {
        el.style.setProperty("--fold-height", `${el.scrollHeight}px`);
        frame.current = requestAnimationFrame(follow);
      };
      follow();
    },
    onAnimationEnd: (event: AnimationEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) stop(event.currentTarget);
    }
  };
}

function stopFollowing(frame: RefObject<number>, el: HTMLElement) {
  cancelAnimationFrame(frame.current);
  el.style.removeProperty("--fold-height");
}
