import type { ReactNode } from "react";
import { Link } from "react-router";
import { AlertCircle, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The three states a view shows instead of its content, one way each
 * (there had been about ten looks for loading, ten for errors,
 * nine for "not found", in seven wordings).
 *
 * - StateMessage: the whole view cannot show its subject — it is not there
 *   ("Worker not found") or would not load. A title, one sentence, one way
 *   on. No frame and no red: a frame means "this wants you", and the action
 *   is all there is to do. Server text is the small last line, never the
 *   title.
 * - InlineError: one part of a view failed. A red alert icon, a plain
 *   sentence, Retry; server text below.
 * - LoadingLine: "Loading…" at the content edge, faint, still. Spinners are
 *   for actions in progress; motion means real activity.
 *
 * Copy: "<Thing> not found" with the reason; "Couldn't load <thing>."
 */

export function StateMessage({ title, children, detail, action, heading = "h2", className }: {
  title: string;
  /** One sentence: why, or what to do. */
  children?: ReactNode;
  /** Technical detail (a server message), shown small. */
  detail?: string | null;
  /** One way on: a BackLink or a StateAction. */
  action?: ReactNode;
  /** h1 when it stands in for a page's own title. */
  heading?: "h1" | "h2";
  className?: string;
}) {
  const Heading = heading;
  return (
    <div data-slot="state-message" className={cn("flex max-w-[46ch] flex-col gap-1.5", className)}>
      <Heading className="text-sm font-semibold text-foreground">{title}</Heading>
      {children ? <p className="text-sm text-muted-foreground">{children}</p> : null}
      {detail ? <p className="text-xs text-faint [overflow-wrap:anywhere]">{detail}</p> : null}
      {action ? <div className="mt-1 flex">{action}</div> : null}
    </div>
  );
}

const ACTION_CLASS =
  "hit relative inline-flex items-center gap-1.5 text-sm text-foreground underline decoration-border underline-offset-[3px] transition-colors hover:decoration-foreground";

/** A StateMessage's way back: "Back to Home". */
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className={ACTION_CLASS}>
      <ArrowLeft className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {children}
    </Link>
  );
}

/** A StateMessage's way on that is not back: "Open it in its thread". */
export function StateLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link to={to} className={ACTION_CLASS}>{children}</Link>;
}

/** A StateMessage's action when it is not a link: Retry, Close tab. */
export function StateAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={ACTION_CLASS}>
      {children}
    </button>
  );
}

export function InlineError({ children, detail, onRetry, className }: {
  /** A plain sentence: "Couldn't load the conversation." */
  children: ReactNode;
  detail?: string | null;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    // 8px above and below on a touch screen: Retry's area reaches 8px past
    // its box and stays inside this one, so whatever sits beside the error
    // keeps its own.
    <div role="alert" data-slot="inline-error" className={cn("flex flex-col gap-1 pointer-coarse:py-2", className)}>
      <div className="flex items-start gap-2 text-sm text-foreground">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
        <span className="min-w-0 flex-1">{children}</span>
        {onRetry ? <Button variant="outline" size="xs" className="shrink-0" onClick={onRetry}>Retry</Button> : null}
      </div>
      {detail ? <p className="pl-6 text-xs text-faint [overflow-wrap:anywhere]">{detail}</p> : null}
    </div>
  );
}

export function LoadingLine({ children = "Loading…", className }: { children?: ReactNode; className?: string }) {
  return (
    <p role="status" data-slot="loading-line" className={cn("text-sm text-faint", className)}>
      {children}
    </p>
  );
}
