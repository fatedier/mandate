import ReactMarkdown from "react-markdown";

/**
 * The work item summary's markdown body, split into its own module so
 * WorkItemDetailBody can import it lazily.
 *
 * It used to import react-markdown directly, and since the component is
 * reachable from the chat panel — which is part of the app shell — that pulled
 * the whole markdown pipeline onto the critical path of every route, defeating
 * the lazy MarkdownView next to it.
 */
export default function WorkItemSummaryMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      components={{
        a: ({ href, children, ...props }) => (
          <a
            {...props}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 hover:text-primary/80"
          >
            {children}
          </a>
        )
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
