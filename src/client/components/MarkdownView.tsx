import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent,
  type MouseEventHandler
} from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, ExternalLink } from "lucide-react";
import { copyTextToClipboard } from "@/lib/clipboard";
import { isTauriRuntime } from "@/lib/runtime";

interface MarkdownViewProps {
  text: string;
  /** Compact sizing for card/list contexts (text-sm) instead of chat sizing. */
  dense?: boolean;
}

interface LinkContextMenu {
  url: string;
  x: number;
  y: number;
}

type LinkContextMenuHandler = (
  event: MouseEvent<HTMLAnchorElement>,
  href: string | undefined
) => void;

function createMarkdownComponents(onLinkContextMenu: LinkContextMenuHandler): Components {
  return {
    pre({ children, node: _node, ...props }) {
      return (
        <pre
          className="bg-terminal-bg text-foreground p-3 rounded-sm my-2 whitespace-pre-wrap [overflow-wrap:anywhere] overflow-x-auto scrollbar-thin"
          {...props}
        >
          {children}
        </pre>
      );
    },
    code({ className, children, node: _node, ...props }) {
      // Block code lives inside the <pre> above; inline code doesn't. remark
      // only sets a `language-` class on fences that name a language, so also
      // treat any multi-line code as a block — otherwise a plain ``` fence
      // with no language would fall through to the inline pill.
      const isBlock =
        /language-/.test(className ?? "") || String(children).includes("\n");
      if (isBlock) {
        return (
          <code className={`font-mono text-sm ${className ?? ""}`} {...props}>
            {children}
          </code>
        );
      }
      return (
        <code
          className="bg-muted px-1 rounded-xs text-[0.85em] font-mono [overflow-wrap:anywhere]"
          {...props}
        >
          {children}
        </code>
      );
    },
    a({ children, href, node: _node, onClick, onContextMenu, ...props }) {
      const handleClick: MouseEventHandler<HTMLAnchorElement> = (event) => {
        onClick?.(event);
        if (event.defaultPrevented || !isTauriRuntime()) return;

        const url = normalizeExternalHttpUrl(href);
        if (!url) return;

        event.preventDefault();
        void openExternalHttpUrl(url);
      };

      const handleContextMenu: MouseEventHandler<HTMLAnchorElement> = (event) => {
        onContextMenu?.(event);
        if (event.defaultPrevented) return;
        onLinkContextMenu(event, href);
      };

      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline"
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          {...props}
        >
          {children}
        </a>
      );
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
      // of pushing the message list horizontally.
      <div className="my-2 max-w-full overflow-x-auto scrollbar-thin">
        <table className="text-sm border-collapse" {...props}>
          {children}
        </table>
      </div>
    ),
    th: ({ children, node: _node, ...props }) => (
      <th className="border border-border-soft px-2 py-1 text-left font-semibold" {...props}>
        {children}
      </th>
    ),
    td: ({ children, node: _node, ...props }) => (
      <td className="border border-border-soft px-2 py-1 align-top" {...props}>
        {children}
      </td>
    )
  };
}

function normalizeExternalHttpUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

async function openExternalHttpUrl(url: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch (error) {
    console.error("[mandate] failed to open external URL", error);
  }
}

async function copyToClipboard(text: string): Promise<void> {
  const ok = await copyTextToClipboard(text);
  if (!ok) console.error("[mandate] failed to copy link");
}

function linkMenuStyle(menu: LinkContextMenu): CSSProperties {
  const width = 184;
  const height = 88;
  const padding = 8;
  const viewportWidth = typeof window === "undefined" ? width + padding * 2 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? height + padding * 2 : window.innerHeight;

  return {
    left: Math.max(padding, Math.min(menu.x, viewportWidth - width - padding)),
    top: Math.max(padding, Math.min(menu.y, viewportHeight - height - padding))
  };
}

export const MarkdownView = memo(function MarkdownView({ text, dense = false }: MarkdownViewProps) {
  const [linkMenu, setLinkMenu] = useState<LinkContextMenu | null>(null);

  const handleLinkContextMenu = useCallback<LinkContextMenuHandler>((event, href) => {
    if (!isTauriRuntime()) return;

    const url = normalizeExternalHttpUrl(href);
    if (!url) return;

    event.preventDefault();
    event.stopPropagation();
    setLinkMenu({ url, x: event.clientX, y: event.clientY });
  }, []);

  const markdownComponents = useMemo(
    () => createMarkdownComponents(handleLinkContextMenu),
    [handleLinkContextMenu]
  );

  useEffect(() => {
    if (!linkMenu) return;

    const close = () => setLinkMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };

    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [linkMenu]);

  const openMenuLink = useCallback(() => {
    const url = linkMenu?.url;
    setLinkMenu(null);
    if (url) void openExternalHttpUrl(url);
  }, [linkMenu?.url]);

  const copyMenuLink = useCallback(() => {
    const url = linkMenu?.url;
    setLinkMenu(null);
    if (url) void copyToClipboard(url);
  }, [linkMenu?.url]);

  return (
    <div
      className={`${dense ? "text-sm leading-[1.45]" : "text-base leading-[1.5]"} min-w-0 [overflow-wrap:anywhere]`}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
      {linkMenu && (
        <div
          role="menu"
          className="fixed z-50 min-w-[184px] overflow-hidden rounded-md border border-border bg-popover py-1 text-sm text-popover-foreground shadow-lg"
          style={linkMenuStyle(linkMenu)}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent hover:text-accent-foreground"
            onClick={openMenuLink}
          >
            <ExternalLink className="h-4 w-4" />
            <span>Open Link</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent hover:text-accent-foreground"
            onClick={copyMenuLink}
          >
            <Copy className="h-4 w-4" />
            <span>Copy Link</span>
          </button>
        </div>
      )}
    </div>
  );
});
