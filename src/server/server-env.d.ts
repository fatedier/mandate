declare module "*.md" {
  const content: string;
  export default content;
}

/** The HTML Standard's encoding sniffing (jsdom's package, which ships no
 *  types): the name of the encoding a page's bytes are in. */
declare module "html-encoding-sniffer" {
  export default function sniffHtmlEncoding(bytes: Uint8Array, options?: {
    xml?: boolean;
    transportLayerEncodingLabel?: string;
    defaultEncoding?: string;
    maxPrescanBytes?: number;
  }): string;
}

declare module "bun:sqlite" {
  export interface StatementResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export interface Statement {
    run(...params: unknown[]): StatementResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  export class Database {
    constructor(filename: string, options?: { readonly?: boolean; create?: boolean });
    /** Path the database was opened with — ":memory:" for an in-memory one. */
    readonly filename: string;
    /** True while a transaction is open on this connection. */
    readonly inTransaction: boolean;
    exec(sql: string): void;
    prepare(sql: string): Statement;
    transaction<T extends unknown[], R>(fn: (...args: T) => R): ((...args: T) => R) & {
      /** BEGIN IMMEDIATE, or a savepoint inside a transaction already open. */
      immediate: (...args: T) => R;
    };
    close(): void;
  }
}

declare module "bun" {
  export interface ServerWebSocket {
    data?: unknown;
    send(data: string | ArrayBuffer | Uint8Array): void;
    close(code?: number, reason?: string): void;
  }
}

declare const Bun: {
  serve(options: {
    port?: number | string;
    hostname?: string;
    fetch: (request: Request) => Response | Promise<Response>;
    websocket?: unknown;
  }): {
    port: number;
    /** `true` closes at once, without waiting for open connections. */
    stop?: (closeActiveConnections?: boolean) => void;
  };
  file(path: string): Blob;
  /** Bun's image pipeline (Bun 1.3.14+): only what the server uses. */
  Image: new (input: Uint8Array, options?: { maxPixels?: number }) => BunImage;
};

interface BunImage {
  resize(width: number, height?: number, options?: { fit?: "fill" | "inside"; withoutEnlargement?: boolean }): BunImage;
  webp(options?: { quality?: number }): BunImage;
  jpeg(options?: { quality?: number }): BunImage;
  png(): BunImage;
  metadata(): Promise<{ width: number; height: number; format: string }>;
  bytes(): Promise<Uint8Array<ArrayBuffer>>;
}

/**
 * Bun's native streaming HTML transformer (lol-html). Declared here for the
 * same reason as the rest of this file: the server is typechecked against node
 * types only, so Bun globals are described locally and narrowly — just the
 * surface the code uses.
 */
declare class HTMLRewriter {
  on(
    selector: string,
    handlers: {
      element?: (element: HTMLRewriterElement) => void;
      text?: (chunk: { text: string; lastInTextNode: boolean }) => void;
    }
  ): HTMLRewriter;
  transform(response: Response): Response;
}

interface HTMLRewriterElement {
  readonly tagName: string;
  /** Throws for an element that cannot have an end tag — self-closed foreign
   *  content among them, which is why callers probe rather than list. */
  onEndTag(handler: () => void): void;
  remove(): void;
}
