import { useId, type ReactNode } from "react";

/** A wavy rule, drawn from a repeating pattern so its waves keep their size
 *  at any width. */
function Wave() {
  // useId's colons are not valid inside `url(#…)`.
  const id = `wave${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  return (
    <svg aria-hidden className="h-1.5 min-w-4 flex-1 text-faint/50" data-slot="context-boundary-wave">
      <defs>
        <pattern id={id} width="8" height="6" patternUnits="userSpaceOnUse">
          <path d="M0 3 Q2 0.6 4 3 T8 3" fill="none" stroke="currentColor" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="100%" height="6" fill={`url(#${id})`} />
    </svg>
  );
}

/** A change to what the agent remembers — its history compacted, a restart it
 *  resumed from — drawn as a few words centred between two wavy rules. The date separator keeps straight rules, so time passing
 *  and memory changing read apart at a glance. */
export function ContextBoundary({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <div data-slot="context-boundary" title={title} className="my-1 flex items-center gap-2.5 text-2xs text-faint">
      <Wave />
      <span className="min-w-0 text-center">{children}</span>
      <Wave />
    </div>
  );
}
