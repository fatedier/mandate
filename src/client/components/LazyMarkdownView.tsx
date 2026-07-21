import { Suspense, lazy } from "react";

/**
 * Defers the markdown pipeline until a message actually renders.
 *
 * The chat dock is part of the app shell, so importing MarkdownView eagerly put
 * unified + micromark + the mdast/hast tail — ~160KB — on the critical path of
 * every page, including ones with no chat content on screen.
 *
 * The fallback renders the raw text rather than a spinner or a blank: markdown
 * degrades to something readable on its own, so the words appear immediately and
 * the formatting arrives a frame later. That also makes streaming feel faster,
 * since the first tokens no longer wait on a chunk fetch.
 */
const MarkdownView = lazy(() =>
  import("@/components/MarkdownView").then((m) => ({ default: m.MarkdownView }))
);

interface LazyMarkdownViewProps {
  text: string;
  dense?: boolean;
}

export function LazyMarkdownView({ text, dense = false }: LazyMarkdownViewProps) {
  return (
    <Suspense
      fallback={
        <div
          className={`${dense ? "text-sm leading-[1.45]" : "text-base leading-[1.5]"} min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]`}
        >
          {text}
        </div>
      }
    >
      <MarkdownView text={text} dense={dense} />
    </Suspense>
  );
}
