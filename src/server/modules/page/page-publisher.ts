import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentStore } from "../agent/agent-store.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import { logError } from "../../platform/logger.js";
import type { PageStore } from "./page-store.js";
import { PAGE_SITE_DIR, readSite, restoreSite, siteDigest, siteFileDigest, type SiteRead } from "./page-site.js";
import {
  ownEditRefusedNote,
  ownSourcesRefusedNote,
  ownUpdatesRefusedNote,
  subagentFailedNote,
  subagentPublishedNote,
  subagentUnchangedNote,
  type SourcesOutcome
} from "./page-notes.js";

export const PAGE_SOURCES_FILE = "sources.json";
export const PAGE_UPDATES_FILE = "updates.json";
/** The digest kept for site/, under this name. */
const SITE_KEY = `${PAGE_SITE_DIR}/`;
/** The digest kept for a sources.json or updates.json that is not there. */
const MISSING = "missing";
/** The personal agent's own edit is filed under this writer. */
export const OWN_EDIT_WRITER = "agent";

/** What applying sources.json (or updates.json) came to: the names now
 *  listed, or why it was refused. Both null: it was not read. */
export interface AppliedSources { names: string[] | null; error: string | null }

/** How a page subagent a scheduled update started ended, for that update. */
export interface ScheduledEnd { status: "updated" | "unchanged" | "failed"; error: string | null }

export interface PagePublisherDeps {
  store: PageStore;
  agentStore: Pick<AgentStore, "enqueueMailboxMessage">;
  pageDir: string;
  personalThreadId: () => string | null;
  applySources: () => AppliedSources;
  /** The running sources as sources.json, to put back. */
  sourcesFile: () => string;
  /** updates.json the same way: applied when it changed, put back after a
   *  failed page subagent. Without them it is not read. */
  applyUpdates?: () => AppliedSources;
  updatesFile?: () => string;
  /** A page subagent ended: whether a scheduled update started it (its
   *  update keeps how it went). */
  scheduledEnded?: (taskId: string, end: ScheduledEnd) => boolean;
  sse: Pick<AgentSseEmitter, "emit">;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** What sources.json's (or updates.json's) content is kept as, to tell
 *  whether it changed. */
export const pageFileDigest = (text: string): string => sha256(text);

/**
 * Publishes the page when whoever edited it ends: the personal agent's turn, or a
 * page subagent. site/, all of it, sources.json and updates.json are each
 * compared with what was last published or applied, so a writer that left
 * them as they were changes nothing and says nothing. A scheduled update's
 * page subagent tells the personal agent only what went wrong.
 */
export class PagePublisher {
  constructor(private readonly deps: PagePublisherDeps) {}

  /** The personal agent's turn ended. Its notes come only when something went wrong.
   *  While a page subagent runs, what is in page/ is its work in progress:
   *  its own end publishes it. */
  afterAgentTurn(): void {
    if (this.deps.store.state().write?.status === "running") return;
    const trouble: string[] = [];
    const site = this.changedSite();
    if (site) {
      if ("files" in site) {
        if (this.deps.store.publish(site.files, OWN_EDIT_WRITER)) this.emitUpdated();
      } else {
        trouble.push(ownEditRefusedNote(site.refused));
      }
      this.deps.store.setFileDigest(SITE_KEY, site.digest);
    }
    const sources = this.applyChangedSources();
    if (sources && "error" in sources) trouble.push(ownSourcesRefusedNote(sources.error));
    const updates = this.applyChangedUpdates();
    if (updates !== null) trouble.push(ownUpdatesRefusedNote(updates));
    if (trouble.length > 0) this.note(trouble.join("\n"));
  }

  /** A page subagent's write began: the pane shows it updating. */
  writeStarted(taskId: string, title: string): void {
    this.deps.store.startWrite(taskId, title);
    this.emitUpdated();
  }

  /** A page subagent ended: its write is finished, and the personal agent hears how
   *  it went, unless `tell` is false (it stopped the subagent itself). One
   *  that failed leaves page/ as it was last published; one that never ran
   *  (`ran` false) left nothing in page/. */
  afterSubagent(input: { taskId: string; title: string; reply: string | null; failed: string | null; tell?: boolean; ran?: boolean; asked?: boolean }): boolean {
    const { store } = this.deps;
    const tell = input.tell !== false;
    const site = input.failed === null ? this.changedSite() : null;
    const refused = site && "refused" in site ? site.refused : null;
    const reason = input.failed ?? refused;
    // Its note wakes the personal agent when the user waited on it or it failed,
    // however it failed (sources.json refused included): mail that starts
    // its turn, the wake itself following the write that ends the run.
    const wakesFor = (failed: boolean) => tell && (input.asked === true || failed);
    if (reason !== null) {
      if (input.ran !== false) this.putBack();
      store.finishWrite(input.taskId, { status: "failed", revision: null, error: reason });
      this.deps.scheduledEnded?.(input.taskId, { status: "failed", error: reason });
      if (tell) this.note(subagentFailedNote({ title: input.title, reason }), wakesFor(true));
      this.emitUpdated();
      return wakesFor(true);
    }
    const version = site && "files" in site ? store.publish(site.files, input.title) : null;
    if (site) store.setFileDigest(SITE_KEY, site.digest);
    const sources = this.applyChangedSources();
    const updatesError = this.applyChangedUpdates();
    const partFailed = (sources !== null && "error" in sources) || updatesError !== null;
    // A scheduled update's run that went well is the page's own business:
    // the personal agent hears of it only when part of it went wrong.
    const scheduled = this.deps.scheduledEnded?.(input.taskId, { status: version ? "updated" : "unchanged", error: null }) ?? false;
    const told = tell && (!scheduled || partFailed);
    const wakes = told && wakesFor(partFailed);
    if (version) {
      store.finishWrite(input.taskId, { status: "published", revision: version.revision, error: null });
      if (told) this.note(subagentPublishedNote({ revision: version.revision, title: input.title, reply: input.reply, sources, updatesError }), wakes);
    } else {
      store.finishWrite(input.taskId, { status: "unchanged", revision: null, error: null });
      if (told) this.note(subagentUnchangedNote({ title: input.title, reply: input.reply, sources, updatesError }), wakes);
    }
    this.emitUpdated();
    return wakes;
  }

  /** site/ when it differs from what was last published or refused; null
   *  when there is no page in it or it is the same. */
  private changedSite(): SiteRead | null {
    const read = readSite(this.siteDir());
    return read && read.digest !== this.deps.store.fileDigest(SITE_KEY) ? read : null;
  }

  private siteDir(): string {
    return path.join(this.deps.pageDir, PAGE_SITE_DIR);
  }

  /** A file's content digest; MISSING only when nothing is there, so a file
   *  that cannot be read (a directory in its place) taken away later is
   *  still a change. */
  private fileDigest(name: string): string {
    const file = path.join(this.deps.pageDir, name);
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

  /** A file applied when it changed (a removed file is a change); null
   *  when it was not read. */
  private applyChanged(name: string, apply: () => AppliedSources): SourcesOutcome | null {
    const digest = this.fileDigest(name);
    const known = this.deps.store.fileDigest(name);
    if (digest === known || (known === null && digest === MISSING)) return null;
    const applied = apply();
    if (applied.names === null && applied.error === null) return null;
    this.deps.store.setFileDigest(name, digest);
    return applied.error !== null ? { error: applied.error } : { names: applied.names ?? [] };
  }

  private applyChangedSources(): SourcesOutcome | null {
    return this.applyChanged(PAGE_SOURCES_FILE, this.deps.applySources);
  }

  /** updates.json applied when it changed: why it was refused, else null. */
  private applyChangedUpdates(): string | null {
    const apply = this.deps.applyUpdates;
    if (!apply) return null;
    const applied = this.applyChanged(PAGE_UPDATES_FILE, apply);
    return applied && "error" in applied ? applied.error : null;
  }

  /** page/ as it was last published and applied, so what a failed subagent
   *  left is neither seen nor published by the personal agent's next edit; a first
   *  page that failed leaves nothing. What cannot be put back is recorded as
   *  it is, so a later turn that never touches it publishes none of it. */
  private putBack(): void {
    const { store, pageDir } = this.deps;
    try {
      const latest = store.state().latest;
      const files = latest ? store.files(latest.revision) : [];
      restoreSite(this.siteDir(), files);
      if (latest) store.setFileDigest(SITE_KEY, siteDigest(files.map((f) => ({ path: f.path, digest: siteFileDigest(f.bytes) }))));
      const listed: Array<[string, () => string]> = [[PAGE_SOURCES_FILE, this.deps.sourcesFile]];
      if (this.deps.applyUpdates && this.deps.updatesFile) listed.push([PAGE_UPDATES_FILE, this.deps.updatesFile]);
      for (const [name, running] of listed) {
        const file = path.join(pageDir, name);
        const known = store.fileDigest(name);
        if (known === null || known === MISSING) {
          fs.rmSync(file, { force: true });
        } else {
          const text = running();
          fs.writeFileSync(file, text);
          store.setFileDigest(name, sha256(text));
        }
      }
    } catch (err) {
      logError("page: page/ could not be put back after a failed page subagent", err);
      this.settleAsTheyAre();
    }
  }

  private settleAsTheyAre(): void {
    const site = readSite(this.siteDir());
    if (site) this.deps.store.setFileDigest(SITE_KEY, site.digest);
    for (const name of this.deps.applyUpdates ? [PAGE_SOURCES_FILE, PAGE_UPDATES_FILE] : [PAGE_SOURCES_FILE]) {
      const digest = this.fileDigest(name);
      if (digest !== MISSING || this.deps.store.fileDigest(name) !== null) this.deps.store.setFileDigest(name, digest);
    }
  }

  private note(text: string, wakes = false): void {
    const threadId = this.deps.personalThreadId();
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
