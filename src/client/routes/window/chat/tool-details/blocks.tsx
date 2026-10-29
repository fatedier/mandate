import type { ReactNode } from "react";
import { CopyButton } from "@/components/CopyButton";
import { SlashBreaks } from "@/components/SlashBreaks";
import { MarkdownView } from "@/components/MarkdownView";
import { cn } from "@/lib/utils";
import { isLongText, useInlineCap } from "./inline-cap";
import type { DiffLine, LineChanges } from "@shared/line-diff";

/** Where a call's details are drawn: open in place in the transcript, or in
 *  the phone's sheet, which is narrower and scrolls as a whole. */
export type DetailLayout = "inline" | "sheet";

/** One labelled part of a call: a heading with a hairline, an optional copy
 *  button, and what it labels below. */
export function DetailSection({ label, tone = "chrome", copyText, actions, slot, children }: {
  label: string;
  tone?: "chrome" | "red";
  copyText?: string;
  actions?: ReactNode;
  slot?: string;
  children: ReactNode;
}) {
  return (
    <div data-slot={slot}>
      {/* On a touch screen 44px tall, so its actions' touch areas stay in
          it, and 20px apart: JSON's area reaches 9px past it, Copy's 10px.
          (Expand shows only inline, in the desktop layout.) */}
      <div className="mb-1 flex items-center gap-2 pointer-coarse:min-h-11 pointer-coarse:gap-5">
        {/* A label can come from a key the model chose, of any length: it
            wraps, and the hairline gives way first. */}
        <span
          data-slot="detail-label"
          className={cn("label-micro min-w-0 [overflow-wrap:anywhere]", tone === "red" ? "text-red" : "text-chrome")}
        >
          {label}
        </span>
        <span aria-hidden className="h-px min-w-3 flex-1 bg-border-soft" />
        {actions}
        {copyText !== undefined && <CopyButton text={copyText} label={`Copy ${label.toLowerCase()}`} />}
      </div>
      {children}
    </div>
  );
}

/** Code as it was: one block that scrolls sideways as a whole, lines kept
 *  together, never reflowed. The box and the scroller are two elements: the
 *  scroller's fade is a mask, and on the box it faded the box's own edge. */
export function CodeBlock({ text, tone = "plain" }: { text: string; tone?: "plain" | "red" }) {
  return (
    <div className={cn("max-w-full rounded-sm", tone === "red" ? "bg-red/10 text-red" : "bg-code-bg text-foreground")}>
      <pre className="scroll-x-quiet whitespace-pre p-2 font-mono text-2xs">{text}</pre>
    </div>
  );
}

/** A sentence someone wrote, wrapped like one. */
export function ProseBlock({ text }: { text: string }) {
  return <div className="rounded-sm bg-code-bg p-2 text-xs text-foreground">{text}</div>;
}

/** Writing a model passed as an argument — a summary, a note, a message — in
 *  markdown, as it was written: it is how the model writes everywhere else,
 *  and the chat renders its own text the same way. */
export function MarkdownBlock({ text, fromWeb = false }: { text: string; fromWeb?: boolean }) {
  return (
    <div data-slot="tool-markdown" className="rounded-sm bg-code-bg p-2 text-foreground">
      <MarkdownView text={text} small fromWeb={fromWeb} />
    </div>
  );
}

/** A markdown document a call returned — a skill — rendered, and capped in
 *  the transcript when long. `text` is the result as it came, for Copy;
 *  `document` what to render of it. */
export function MarkdownOutput({ text, document, layout, label = "Output", fromWeb = false }: {
  text: string;
  document: string;
  layout: DetailLayout;
  label?: string;
  fromWeb?: boolean;
}) {
  const cap = useInlineCap(layout, isLongText(text));
  return (
    <DetailSection label={label} copyText={text} actions={cap.toggle}>
      <div className={cap.boxClass}>
        <MarkdownBlock text={document} fromWeb={fromWeb} />
      </div>
    </DetailSection>
  );
}

/** What a call printed, capped in the transcript when long (useInlineCap).
 *
 *  The two axes are split across two elements on purpose. The wrapper caps
 *  height and owns vertical scrolling, which keeps a normal scrollbar; the
 *  inner pre owns horizontal overflow and hides its bar. Putting both on one
 *  element meant `scrollbar-width: none` suppressed the vertical bar too.
 *
 *  `whitespace-pre`, not `pre-wrap`: `git diff --stat` draws a column of bars
 *  and table-shaped output aligns by character, so reflowing destroys the
 *  alignment that carries the meaning. */
export function OutputBlock({ label, text, tone = "plain", layout }: {
  label: string;
  text: string;
  tone?: "plain" | "red";
  layout: DetailLayout;
}) {
  const cap = useInlineCap(layout, isLongText(text));
  return (
    <DetailSection
      label={label}
      tone={tone === "red" ? "red" : "chrome"}
      copyText={text}
      actions={cap.toggle}
    >
      <div
        data-slot="tool-output"
        className={cn(
          "max-w-full rounded-sm text-2xs",
          tone === "red" ? "bg-red/10 text-red" : "bg-code-bg text-foreground",
          cap.boxClass
        )}
      >
        <pre className="scroll-x-quiet whitespace-pre p-2">{text}</pre>
      </div>
    </DetailSection>
  );
}

/** A file's path, its folder dimmed and its name in weight. Wrapped, never
 *  cut: on a phone there is no hover to read a clipped folder back. It breaks
 *  after a slash where it can, and inside a name only when one is longer than
 *  the line. */
export function PathLine({ path, note }: { path: string; note?: string }) {
  const cut = path.lastIndexOf("/");
  const folder = cut >= 0 ? path.slice(0, cut + 1) : "";
  const name = cut >= 0 ? path.slice(cut + 1) : path;
  return (
    <div data-slot="tool-path" className="rounded-sm bg-code-bg p-2 font-mono text-2xs [overflow-wrap:anywhere]">
      <span className="text-faint">
        <SlashBreaks text={folder} />
      </span>
      <span className="font-semibold text-foreground">{name}</span>
      {note && <span data-slot="tool-path-note" className="ml-2 whitespace-nowrap font-sans text-faint">{note}</span>}
    </div>
  );
}

const DIFF_ROW = {
  " ": "text-muted-foreground",
  "-": "bg-diff-del-bg text-diff-del-fg",
  "+": "bg-diff-add-bg text-diff-add-fg"
} as const;
const DIFF_SIGN = { " ": " ", "-": "−", "+": "+" } as const;

/** Lines removed in red, added in green, the rest as context; one block that
 *  scrolls sideways as a whole (inside the box, as CodeBlock's does). */
export function DiffBlock({ lines }: { lines: DiffLine[] }) {
  return (
    <div data-slot="tool-diff" className="max-w-full rounded-sm bg-code-bg py-1.5 font-mono text-2xs">
      <div className="scroll-x-quiet">
      <div className="inline-flex min-w-full flex-col">
        {lines.map((line, index) => (
          <div key={index} data-diff={line.kind === " " ? "context" : line.kind === "-" ? "removed" : "added"} className={cn("flex", DIFF_ROW[line.kind])}>
            <span aria-hidden className="w-5 shrink-0 select-none text-center">{DIFF_SIGN[line.kind]}</span>
            {line.kind !== " " && <span className="sr-only">{line.kind === "-" ? "removed: " : "added: "}</span>}
            <span className="whitespace-pre pr-2">{line.text || " "}</span>
          </div>
        ))}
      </div>
      </div>
    </div>
  );
}

/** Lines added and removed, as the Changes tab writes them: `+12 −3`. A pill
 *  tints each count (a call in a list of calls). */
export function LineCounts({ changes, variant, className }: { changes: LineChanges | null; variant?: "pill"; className?: string }) {
  if (!changes) return null;
  if (variant === "pill") {
    return (
      <span data-slot="line-counts" data-variant="pill" className="flex shrink-0 overflow-hidden whitespace-nowrap rounded-sm font-mono text-2xs">
        <span className="bg-diff-add-fg/15 px-1.5 text-diff-add-fg">+{changes.added}</span>
        <span className="bg-diff-del-fg/15 px-1.5 text-diff-del-fg">−{changes.removed}</span>
      </span>
    );
  }
  return (
    <span data-slot="line-counts" className={cn("shrink-0 whitespace-nowrap font-mono text-2xs", className)}>
      <span className="text-diff-add-fg">+{changes.added}</span>{" "}
      <span className="text-diff-del-fg">−{changes.removed}</span>
    </span>
  );
}
