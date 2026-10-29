/** A page as web_fetch read it, kept so that reading on comes from the same
 *  version of the page. */
export interface KeptPage {
  finalUrl: string;
  cut: boolean;
  title?: string;
  author?: string;
  published?: string;
  site?: string;
  text: string;
}

const KEEP_MS = 15 * 60_000;
const MAX_KEPT = 32;
/** The text all kept copies hold together, in characters (about 32 MB in
 *  memory): 32 pages of up to 5 MB each would hold far more. */
const MAX_KEPT_CHARS = 16 * 1024 * 1024;

/** The pages read lately, by the address asked for: each for 15 minutes, at
 *  most 32 and at most MAX_KEPT_CHARS of text together, the oldest read
 *  dropped first (the page read last is kept whatever its size). In memory
 *  only: after a restart a page is read again. */
export class PageCopies {
  private pages = new Map<string, { page: KeptPage; at: number }>();
  private now: () => number;
  private ttlMs: number;
  private max: number;
  private maxChars: number;

  constructor(opts: { now?: () => number; ttlMs?: number; max?: number; maxChars?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? KEEP_MS;
    this.max = opts.max ?? MAX_KEPT;
    this.maxChars = opts.maxChars ?? MAX_KEPT_CHARS;
  }

  get(url: string): KeptPage | null {
    const kept = this.pages.get(url);
    if (!kept) return null;
    if (this.now() - kept.at > this.ttlMs) {
      this.pages.delete(url);
      return null;
    }
    return kept.page;
  }

  set(url: string, page: KeptPage): void {
    // A page read again counts as read now.
    this.pages.delete(url);
    this.pages.set(url, { page, at: this.now() });
    let chars = 0;
    for (const { page: kept } of this.pages.values()) chars += kept.text.length;
    while (this.pages.size > 1 && (this.pages.size > this.max || chars > this.maxChars)) {
      const oldest = this.pages.keys().next().value as string;
      chars -= this.pages.get(oldest)!.page.text.length;
      this.pages.delete(oldest);
    }
  }
}
