declare module "*.md" {
  const content: string;
  export default content;
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
    transaction<T extends unknown[], R>(fn: (...args: T) => R): (...args: T) => R;
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
    stop?: () => void;
  };
  file(path: string): Blob;
};

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
