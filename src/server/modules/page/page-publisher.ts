import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentStore } from "../agent/agent-store.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import { CANVAS_PAGE_MAX_BYTES } from "../../../shared/canvas-page.js";
import { errorText } from "../../../shared/error-text.js";
import { logError } from "../../platform/logger.js";
import type { PageStore } from "./page-store.js";
import {
  ownEditRefusedNote,
  ownSourcesRefusedNote,
  subagentFailedNote,
  subagentPublishedNote,
  subagentUnchangedNote,
  type SourcesOutcome
} from "./page-notes.js";

export const PAGE_INDEX_FILE = "index.html";
export const PAGE_SOURCES_FILE = "sources.json";
/** The digest kept for a sources.json that is not there. */
const MISSING = "missing";
/** Your agent's own edit is filed under this writer. */
export const OWN_EDIT_WRITER = "agent";

/** What applying sources.json came to: the names now listed, or why it was
 *  refused. Both null: it was not read. */
export interface AppliedSources { names: string[] | null; error: string | null }

export interface PagePublisherDeps {
  store: PageStore;
  agentStore: Pick<AgentStore, "enqueueMailboxMessage">;
  pageDir: string;
  globalThreadId: () => string | null;
  applySources: () => AppliedSources;
  /** The running sources as sources.json, to put back. */
  sourcesFile: () => string;
  sse: Pick<AgentSseEmitter, "emit">;
}

type IndexRead = { digest: string; html: string } | { digest: string; refused: string };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** What a page file's content is kept as, to tell whether it changed. */
export const pageFileDigest = (text: string): string => sha256(text);

/**
 * Publishes the page when whoever edited it ends: Your agent's turn, or a
 * page subagent. Each file is compared with what was last published or
 * applied, so a writer that left it as it was changes nothing and says
 * nothing.
 */
export class PagePublisher {
  constructor(private readonly deps: PagePublisherDeps) {}

  /** Your agent's turn ended. Its notes come only when something went wrong.
   *  While a page subagent runs, what is in page/ is its work in progress:
   *  its own end publishes it. */
  afterAgentTurn(): void {
    if (this.deps.store.state().write?.status === "running") return;
    const trouble: string[] = [];
    const index = this.changedIndex();
    if (index) {
      if ("html" in index) {
        if (this.deps.store.publish(index.html, OWN_EDIT_WRITER)) this.emitUpdated();
      } else {
        trouble.push(ownEditRefusedNote(index.refused));
      }
      this.deps.store.setFileDigest(PAGE_INDEX_FILE, index.digest);
    }
    const sources = this.applyChangedSources();
    if (sources && "error" in sources) trouble.push(ownSourcesRefusedNote(sources.error));
    if (trouble.length > 0) this.note(trouble.join("\n"));
  }

  /** A page subagent's write began: the pane shows it updating. */
  writeStarted(taskId: string, title: string): void {
    this.deps.store.startWrite(taskId, title);
    this.emitUpdated();
  }

  /** A page subagent ended: its write is finished, and Your agent hears how
   *  it went, unless `tell` is false (it stopped the subagent itself). One
   *  that failed leaves page/ as it was last published; one that never ran
   *  (`ran` false) left nothing in page/. */
  afterSubagent(input: { taskId: string; title: string; reply: string | null; failed: string | null; tell?: boolean; ran?: boolean; asked?: boolean }): boolean {
    const { store } = this.deps;
    const tell = input.tell !== false;
    const index = input.failed === null ? this.changedIndex() : null;
    const refused = index && "refused" in index ? index.refused : null;
    const reason = input.failed ?? refused;
    // Its note wakes Your agent when the user waited on it or it failed,
    // however it failed (sources.json refused included): mail that starts
    // its turn, the wake itself following the write that ends the run.
    const wakesFor = (failed: boolean) => tell && (input.asked === true || failed);
    if (reason !== null) {
      if (input.ran !== false) this.putBack();
      store.finishWrite(input.taskId, { status: "failed", revision: null, error: reason });
      if (tell) this.note(subagentFailedNote({ title: input.title, reason }), wakesFor(true));
      this.emitUpdated();
      return wakesFor(true);
    }
    const version = index && "html" in index ? store.publish(index.html, input.title) : null;
    if (index) store.setFileDigest(PAGE_INDEX_FILE, index.digest);
    const sources = this.applyChangedSources();
    const wakes = wakesFor(sources !== null && "error" in sources);
    if (version) {
      store.finishWrite(input.taskId, { status: "published", revision: version.revision, error: null });
      if (tell) this.note(subagentPublishedNote({ revision: version.revision, title: input.title, reply: input.reply, sources }), wakes);
    } else {
      store.finishWrite(input.taskId, { status: "unchanged", revision: null, error: null });
      if (tell) this.note(subagentUnchangedNote({ title: input.title, reply: input.reply, sources }), wakes);
    }
    this.emitUpdated();
    return wakes;
  }

  /** index.html when it differs from what was last published or refused;
   *  null when it is missing or the same. */
  private changedIndex(): IndexRead | null {
    const read = this.readIndex();
    return read && read.digest !== this.deps.store.fileDigest(PAGE_INDEX_FILE) ? read : null;
  }

  private readIndex(): IndexRead | null {
    const file = path.join(this.deps.pageDir, PAGE_INDEX_FILE);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    // Sized on disk first: an oversized page is refused without reading it.
    if (stat.size > CANVAS_PAGE_MAX_BYTES) {
      const mb = (stat.size / 1024 / 1024).toFixed(1);
      return { digest: `over:${stat.size}:${stat.mtimeMs}`, refused: `${PAGE_INDEX_FILE} is ${mb} MB, over the 16 MB limit` };
    }
    try {
      const html = fs.readFileSync(file, "utf8");
      return { digest: sha256(html), html };
    } catch (err) {
      return { digest: `unreadable:${stat.mtimeMs}`, refused: `${PAGE_INDEX_FILE} could not be read: ${errorText(err)}` };
    }
  }

  /** Its content's digest; MISSING only when nothing is there, so a file
   *  that cannot be read (a directory in its place) taken away later is
   *  still a change. */
  private sourcesDigest(): string {
    const file = path.join(this.deps.pageDir, PAGE_SOURCES_FILE);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return MISSING;
    }
    try {
      return sha256(fs.readFileSync(file, "utf8"));
    } catch {
      return `unreadable:${stat.mtimeMs}`;
    }
  }

  /** sources.json applied when it changed (a removed file is a change);
   *  null when it was not read. */
  private applyChangedSources(): SourcesOutcome | null {
    const digest = this.sourcesDigest();
    const known = this.deps.store.fileDigest(PAGE_SOURCES_FILE);
    if (digest === known || (known === null && digest === MISSING)) return null;
    const applied = this.deps.applySources();
    if (applied.names === null && applied.error === null) return null;
    this.deps.store.setFileDigest(PAGE_SOURCES_FILE, digest);
    return applied.error !== null ? { error: applied.error } : { names: applied.names ?? [] };
  }

  /** page/ as it was last published and applied, so what a failed subagent
   *  left is neither seen nor published by Your agent's next edit; a first
   *  page that failed leaves nothing. What cannot be put back is recorded as
   *  it is, so a later turn that never touches it publishes none of it. */
  private putBack(): void {
    const { store, pageDir } = this.deps;
    try {
      const index = path.join(pageDir, PAGE_INDEX_FILE);
      const latest = store.latest();
      if (latest) {
        fs.writeFileSync(index, latest.html);
        store.setFileDigest(PAGE_INDEX_FILE, sha256(latest.html));
      } else {
        fs.rmSync(index, { force: true });
      }
      const sources = path.join(pageDir, PAGE_SOURCES_FILE);
      const known = store.fileDigest(PAGE_SOURCES_FILE);
      if (known === null || known === MISSING) {
        fs.rmSync(sources, { force: true });
      } else {
        const text = this.deps.sourcesFile();
        fs.writeFileSync(sources, text);
        store.setFileDigest(PAGE_SOURCES_FILE, sha256(text));
      }
    } catch (err) {
      logError("page: page/ could not be put back after a failed page subagent", err);
      this.settleAsTheyAre();
    }
  }

  private settleAsTheyAre(): void {
    const index = this.readIndex();
    if (index) this.deps.store.setFileDigest(PAGE_INDEX_FILE, index.digest);
    const sources = this.sourcesDigest();
    if (sources !== MISSING || this.deps.store.fileDigest(PAGE_SOURCES_FILE) !== null) {
      this.deps.store.setFileDigest(PAGE_SOURCES_FILE, sources);
    }
  }

  private note(text: string, wakes = false): void {
    const threadId = this.deps.globalThreadId();
    if (!threadId) return;
    this.deps.agentStore.enqueueMailboxMessage({
      threadId,
      role: "user",
      source: "page-result",
      content: { type: "text", text },
      triggerTurn: wakes
    });
  }

  private emitUpdated(): void {
    this.deps.sse.emit(SSE_EVENTS.agentPageUpdated, { state: this.deps.store.state() });
  }
}
