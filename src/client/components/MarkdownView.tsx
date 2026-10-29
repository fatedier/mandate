import {
  createContext,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type MouseEventHandler,
  type ReactNode
} from "react";
import { useInRouterContext } from "react-router";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
// CommonMark leaves `**注意：**这` unclosed (a full-width colon before Han
// text does not end emphasis); this is the CJK-friendly amendment to it.
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import stringWidth from "string-width";
import { markdownSizeClass } from "./markdown-size";
import { Copy, ExternalLink, FileText } from "lucide-react";
import { copyTextToClipboard } from "@/lib/clipboard";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { isTauriRuntime } from "@/lib/runtime";
import { normalizeExternalHttpUrl, openExternalHttpUrl } from "@/lib/open-external";
import { canvasIdOfPath, canvasPathOf } from "@/lib/canvas-link";
import { useOpenCanvas } from "@/routes/canvas/canvas-opener";
import { remarkCanvasPaths } from "@/lib/remark-canvas-paths";
import { useCanvasTitles } from "@/store/canvas-titles";

const REMARK_PLUGINS = [remarkGfm, remarkCjkFriendly];
// What an agent wrote: a canvas's path bare in its text is a link as well.
const AGENT_REMARK_PLUGINS = [...REMARK_PLUGINS, remarkCanvasPaths];
// What an inline rendering keeps; every other element gives up its tag and
// keeps its text (react-markdown's unwrapDisallowed).
const INLINE_ELEMENTS = ["code", "strong", "em", "del"];

interface MarkdownViewProps {
  text: string;
  /** Compact sizing for card/list contexts (text-sm) instead of chat sizing. */
  dense?: boolean;
  /** One step down again (text-xs), for writing quoted inside a panel of
   *  small print, such as a tool call's details. */
  small?: boolean;
  /** Phrasing only, for writing inside a row that is itself a button: code
   *  and emphasis render, a link is its words, blocks run together as one
   *  passage, and nothing wraps it, so the row's own box sets the size and
   *  the clamp. */
  inline?: boolean;
  /** Writing that came from the web: an image is a link to it, never
   *  loaded, and no code in it links into Mandate. */
  fromWeb?: boolean;
}

/** `linkCanvasPaths`: whether inline code that is a canvas's path is drawn as
 *  the link to it. Not inside a row that is itself a button, where a link is
 *  its words. */
function createMarkdownComponents(linkCanvasPaths: boolean, imagesAsLinks = false): Components {
  return {
    ...(imagesAsLinks
      ? {
          img({ src, alt }) {
            const href = typeof src === "string" ? src : "";
            return <MarkdownLink href={href}>{alt || href}</MarkdownLink>;
          }
        } satisfies Components
      : {}),
    pre({ children, node: _node, ...props }) {
      return <CodeBlock preProps={props}>{children}</CodeBlock>;
    },
    code({ className, children, node: _node, ...props }) {
      // Block code lives inside the <pre> above; inline code doesn't. remark
      // only sets a `language-` class on fences that name a language, so also
      // treat any multi-line code as a block — otherwise a plain ``` fence
      // with no language would fall through to the inline pill.
      const isBlock =
        /language-/.test(className ?? "") || String(children).includes("\n");
      if (isBlock) {
        // 13px, not the prose's 14px: the mono face is optically larger at
        // the same size, and a block that outsizes the paragraph around it
        // reads as shouting.
        return (
          <code className={`font-mono text-xs leading-[1.55] ${className ?? ""}`} {...props}>
            {children}
          </code>
        );
      }
      const code = (
        <code
          className="bg-muted px-1 rounded-xs text-[0.85em] font-mono [overflow-wrap:anywhere]"
          {...props}
        >
          {children}
        </code>
      );
      return linkCanvasPaths ? <CanvasPathCode text={textOf(children)}>{code}</CanvasPathCode> : code;
    },
    a({ node: _node, ...props }) {
      return <MarkdownLink {...props} />;
    },
    ul({ children, node: _node, ...props }) {
      return (
        <ul className="list-disc pl-5 my-1" {...props}>
          {children}
        </ul>
      );
    },
    ol({ children, node: _node, ...props }) {
      return (
        <ol className="list-decimal pl-5 my-1" {...props}>
          {children}
        </ol>
      );
    },
    // Three distinct steps. Previously h2 and h3 both rendered at
    // `text-base font-semibold`, so a document's second and third heading
    // levels were visually identical and its structure collapsed. Space above
    // a heading scales with its level; space below stays tight so each heading
    // groups with the text it introduces.
    h1: ({ children, node: _node, ...props }) => (
      <h3 className="mt-4 mb-2 text-xl font-semibold" {...props}>
        {children}
      </h3>
    ),
    h2: ({ children, node: _node, ...props }) => (
      <h4 className="mt-3 mb-1.5 text-lg font-semibold" {...props}>
        {children}
      </h4>
    ),
    h3: ({ children, node: _node, ...props }) => (
      <h5 className="mt-3 mb-1 text-base font-semibold" {...props}>
        {children}
      </h5>
    ),
    p: ({ children, node: _node, ...props }) => (
      <p className="my-1" {...props}>
        {children}
      </p>
    ),
    table: ({ children, node: _node, ...props }) => (
      // Wrap tables so long rows scroll inside the message bubble instead
      // of pushing the message list horizontally. The table breaks between
      // words only (its code too): the text around it breaks anywhere, and a
      // table that inherited that could shrink every column to one letter, so
      // it squeezed in with words split instead of reaching this scroller.
      // In a phone-width box a cell with long text keeps a readable minimum
      // width (TableCell), so the table scrolls instead of squeezing such a
      // column until it fits (a phone's notes cell ran to ten lines), and a
      // short cell does not wrap at all (Han breaks between any two
      // characters: a short label went one character a line). The
      // box is a size container, so it is the table's width that decides;
      // in a wider box the table fills it as before. Its bar is one a reader
      // drags: scrollbar-drag keeps it faint under the pointer too.
      <div data-slot="table-scroll" className="scrollbar-drag @container my-2 max-w-full overflow-x-auto">
        <table className="text-sm border-collapse [overflow-wrap:normal] [&_code]:[overflow-wrap:normal]" {...props}>
          {children}
        </table>
      </div>
    ),
    th: ({ children, node, ...props }) => {
      const long = textWidthCh(node) > LONG_CELL_CH;
      return (
        <th className={`border border-border-soft px-2 py-1 text-left font-semibold${long ? "" : " whitespace-nowrap"}`} {...props}>
          <TableCell long={long}>{children}</TableCell>
        </th>
      );
    },
    td: ({ children, node, ...props }) => {
      const long = textWidthCh(node) > LONG_CELL_CH;
      return (
        <td className={`border border-border-soft px-2 py-1 align-top${long ? "" : " whitespace-nowrap"}`} {...props}>
          <TableCell long={long}>{children}</TableCell>
        </td>
      );
    }
  };
}

/** Whether what is drawn is inside a link already: a canvas's path written
 *  as code there is the link's words, not a second link. */
const InsideLink = createContext(false);

/** A link in what an agent wrote. One to a canvas of this app opens the
 *  canvas over the page it is linked from, as the canvas's card does: a new
 *  tab took the reader out of the conversation the canvas was made in.
 *  Outside a router (the markdown drawn alone) every link is a plain one. */
function MarkdownLink(props: ComponentProps<"a">) {
  // A link whose words are its own address (a canvas's path written bare,
  // made a link) names its canvas by title.
  const canvas = canvasPathOf(props.href, window.location.href);
  const children = canvas && wordsOf(props.children) === props.href ? <CanvasTitle path={canvas} fallback={props.children} /> : props.children;
  return useInRouterContext() ? <RoutedLink {...props}>{children}</RoutedLink> : <PlainLink {...props}>{children}</PlainLink>;
}

/** Its words when a link's content is words alone. */
function wordsOf(children: ReactNode): string | null {
  if (typeof children === "string") return children;
  return Array.isArray(children) && children.length === 1 && typeof children[0] === "string" ? children[0] : null;
}

/** A canvas's path drawn as the canvas's title once it is read; the path
 *  meanwhile, and for a canvas that is not there. */
function CanvasTitle({ path, fallback }: { path: string; fallback: ReactNode }) {
  const id = canvasIdOfPath(path);
  const title = useCanvasTitles((s) => (id ? s.titles.get(id) : undefined));
  // Each draw: a read that failed is tried again when the reply draws again
  // (as it streams); the store asks once for each, and nothing for a title
  // it keeps.
  useEffect(() => {
    if (id) useCanvasTitles.getState().want(id);
  });
  if (!title) return <>{fallback}</>;
  return (
    <>
      <FileText data-slot="canvas-title-icon" aria-hidden className="mr-1 inline size-3.5 align-[-0.15em]" />
      {title.title}
    </>
  );
}

function RoutedLink(props: ComponentProps<"a">) {
  const openCanvas = useOpenCanvas();
  const canvas = canvasPathOf(props.href, window.location.href);
  const canvasId = canvas ? canvasIdOfPath(canvas) : null;
  return <PlainLink {...props} openInPlace={canvas && canvasId ? () => openCanvas(canvasId, canvas) : undefined} />;
}

function PlainLink({ children, href, onClick, openInPlace, ...props }: ComponentProps<"a"> & { openInPlace?: () => void }) {
  const handleClick: MouseEventHandler<HTMLAnchorElement> = (event) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    // A plain click only: with a modifier key or another button the link is
    // the browser's, which opens it in a new tab or window.
    if (openInPlace && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      openInPlace();
      return;
    }
    if (!isTauriRuntime()) return;

    const url = normalizeExternalHttpUrl(href);
    if (!url) return;

    event.preventDefault();
    void openExternalHttpUrl(url);
  };

  const link = (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline"
      onClick={handleClick}
      {...props}
    >
      <InsideLink.Provider value>{children}</InsideLink.Provider>
    </a>
  );
  // A browser keeps its own menu for a link; the desktop app's webview
  // offers nothing useful, so an http link gets this one.
  const url = isTauriRuntime() ? normalizeExternalHttpUrl(href) : null;
  return url ? <LinkMenu url={url}>{link}</LinkMenu> : link;
}

/** Inline code that is a canvas's path, drawn as the link to that canvas:
 *  agents often write the path this way, and as code it could not be opened.
 *  Named by the canvas's title once read; until then it stays code, inside
 *  the link. */
function CanvasPathCode({ text, children }: { text: string; children: ReactNode }) {
  const insideLink = useContext(InsideLink);
  const path = insideLink ? null : canvasPathOf(text, window.location.href);
  return path ? <MarkdownLink href={path}><CanvasTitle path={path} fallback={children} /></MarkdownLink> : <>{children}</>;
}

/**
 * A fenced block as a lifted card: a 28px strip naming the language (when the
 * fence did) with a Copy button, over the `<pre>`. The strip is what separates
 * the block from the chat around it — the fill alone, a few steps from the
 * page in either direction, kept reading as the same surface.
 */
function CodeBlock({
  children,
  preProps
}: {
  children: ReactNode;
  preProps: Record<string, unknown>;
}) {
  const language = languageOf(children);
  const text = textOf(children);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );
  const copy = useCallback(async () => {
    const ok = await copyTextToClipboard(text);
    if (!ok) return;
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  }, [text]);
  // Copy is revealed, not shown: hidden until the block is hovered or the
  // button is focused, kept visible while it says Copied, and always visible
  // on touch screens, which have no hover. A block with a language gets the
  // strip and the button lives in it; an unnamed block gets no strip (an
  // empty 28px band said nothing) and the button floats in its corner.
  const copyButton = (
    <button
      type="button"
      aria-label="Copy code"
      className={[
        "hit rounded-sm px-1.5 text-2xs text-muted-foreground transition-opacity hover:bg-sel hover:text-foreground",
        "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
        copied ? "opacity-100" : "",
        language ? "relative" : "absolute top-1.5 right-1.5 bg-code-bg"
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={() => void copy()}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
  return (
    <div
      data-slot="code-block"
      className="group relative my-2 rounded-md border border-border-soft bg-code-bg"
    >
      {language ? (
        <div
          data-slot="code-head"
          className="flex h-7 items-center gap-2 rounded-t-md border-b border-border-soft px-3 text-2xs text-chrome"
        >
          <span data-slot="code-lang" className="font-mono">
            {language}
          </span>
          <span className="flex-1" />
          {copyButton}
        </div>
      ) : (
        copyButton
      )}
      {/* Corners rounded on the parts, not clipped by the block: Copy's
          touch area reaches past the block's edge. */}
      <pre
        className={`${language ? "rounded-b-md" : "rounded-md"} bg-code-bg text-foreground px-3 py-2.5 whitespace-pre-wrap [overflow-wrap:anywhere] overflow-x-auto`}
        {...preProps}
      >
        {children}
      </pre>
    </div>
  );
}

/** Tags that name no language: the strip shows nothing for them rather than
 *  a word that says "this is text". */
const UNNAMED_LANGUAGES = new Set(["text", "plain", "plaintext", "txt"]);

/** The fence's language, from the `language-*` class remark puts on the code child. */
function languageOf(children: ReactNode): string | null {
  if (!isValidElement<{ className?: string }>(children)) return null;
  const match = /language-([\w+#-]+)/.exec(children.props.className ?? "");
  const tag = match?.[1] ?? null;
  return tag && !UNNAMED_LANGUAGES.has(tag.toLowerCase()) ? tag : null;
}

/** The fence's literal text — what Copy writes — from the code child's strings. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

async function copyToClipboard(text: string): Promise<void> {
  const ok = await copyTextToClipboard(text);
  if (!ok) console.error("[mandate] failed to copy link");
}

/** The desktop app's menu for a link: open it in the browser, or copy it.
 *  A Radix context menu, at the document's top level: a menu drawn inside
 *  the text was faded and clipped by a transcript's masked edges, and inside
 *  a modal dialog Radix keeps its pointer events on where the dialog turned
 *  the page's off. Not modal: a modal menu's focus trap takes focus back from
 *  the textarea the clipboard fallback copies from, and nothing is copied. */
function LinkMenu({ url, children }: { url: string; children: ReactNode }) {
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-[184px]">
        <ContextMenuItem onSelect={() => void openExternalHttpUrl(url)}>
          <ExternalLink />
          <span>Open Link</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copyToClipboard(url)}>
          <Copy />
          <span>Copy Link</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

const MARKDOWN_COMPONENTS = createMarkdownComponents(true);
const INLINE_MARKDOWN_COMPONENTS = createMarkdownComponents(false);
const WEB_MARKDOWN_COMPONENTS = createMarkdownComponents(false, true);

export const MarkdownView = memo(function MarkdownView({ text, dense = false, small = false, inline = false, fromWeb = false }: MarkdownViewProps) {
  if (inline) {
    return (
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={INLINE_MARKDOWN_COMPONENTS} allowedElements={INLINE_ELEMENTS} unwrapDisallowed>
        {text}
      </ReactMarkdown>
    );
  }

  return (
    <div
      data-slot="markdown"
      className={`${markdownSizeClass({ dense, small })} min-w-0 [overflow-wrap:anywhere]`}
    >
      <ReactMarkdown remarkPlugins={fromWeb ? REMARK_PLUGINS : AGENT_REMARK_PLUGINS} components={fromWeb ? WEB_MARKDOWN_COMPONENTS : MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** Text wider than this, in ch, makes a table cell "long". */
const LONG_CELL_CH = 22;

/** A cell's text, all of it at once: an accent split from its letter by
 *  emphasis still belongs to it. */
function cellText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const { type, value, children } = node as { type?: string; value?: unknown; children?: unknown[] };
  if (type === "text" && typeof value === "string") return value;
  return Array.isArray(children) ? children.map(cellText).join("") : "";
}

/** How wide a cell's text would run on one line, in ch: its display width
 *  (string-width, the measure remark-gfm aligns tables by), where a
 *  combining accent adds nothing and East Asian wide characters and emoji
 *  take two. Han breaks between any two characters, so a table could
 *  squeeze such a column to one. */
function textWidthCh(node: unknown): number {
  return stringWidth(cellText(node));
}

/** A table cell's content. In a box under 30rem (the table's scroller is
 *  the container) a long one keeps at least 28ch, so the table scrolls
 *  rather than squeezing it; a short one is left as it is, and a wider box
 *  lays the table out as before (any minimum there shifted columns that
 *  were not squeezed). The minimum sits on an inline box inside the cell: a
 *  cell's own min-width is not reliable in every engine, and a block box
 *  would turn a copied row's tabs into line breaks. */
function TableCell({ long, children }: { long: boolean; children?: ReactNode }) {
  if (!long) return <>{children}</>;
  return <span className="inline-block @max-[30rem]:min-w-[28ch]">{children}</span>;
}
