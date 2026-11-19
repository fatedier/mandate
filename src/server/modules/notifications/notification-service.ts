import type { Config, NotificationChannelConfig } from "../../config.js";
import type { HttpClient } from "../../platform/http/http-client.js";
import { logError } from "../../platform/logger.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import { channelNoticeText } from "../../../shared/notice-text.js";
import { PRESENCE_HEARTBEAT_MS, type NotificationTestResponse, type PresenceReport, type TelegramConnectResponse } from "../../../shared/api/notifications.js";
import type { NotificationChannelPatch } from "../../../shared/settings.js";
import type { ChannelContext, ChannelKind, OutgoingNotification } from "./channel-kind.js";
import { CHANNEL_KINDS } from "./channels/index.js";
import { connectTelegram } from "./channels/telegram.js";
import { ESCALATE_AFTER_MS, matterShownBy, planDelivery, windowInUse, type DeliveryPlan } from "./delivery-plan.js";
import type { NotificationLevel, NotificationRow, NotificationSource, NotificationStore } from "./notification-store.js";
import type { PresenceBook } from "./presence.js";

/** The same words on the same matter this soon are not sent again. */
export const DUPLICATE_WINDOW_MS = 10 * 60_000;
/** Notices a channel takes in a rolling hour; past it one "More in Mandate". */
export const HOURLY_CAP = 20;
export const TICK_MS = 15_000;
/** After a start, no phone send goes until the windows have had a heartbeat
 *  to say where the user is (the presence book starts empty). */
export const STARTUP_GRACE_MS = Math.round(PRESENCE_HEARTBEAT_MS * 1.5);
const HOUR_MS = 3_600_000;
/** The windows' part of a notice, as a send of its own: an escalation knows
 *  whether system notifications went already. */
const WINDOWS_CHANNEL = "windows";
/** Its toasts, recorded apart (an escalation still owes the system
 *  notifications): which notice the windows show last. */
const TOAST_CHANNEL = "windows-toast";

/** The names Mandate's own windows go by, in the agent's list and in its lines. */
const BROWSER = "Browser";
const DESKTOP_APP = "Desktop app";

const NOT_SENT_LOOKING = { line: "Not sent: the user is looking at it.", notSent: "looking" } as const;
/** Its page on screen in a window not in use: it waits HOLD_MS. The line is
 *  how a waiting notice is known again, after a restart too. */
const NOT_SENT_HELD = { line: "Not sent yet: the user may be looking at it. It goes out in 2 minutes unless they see it first.", notSent: "held" } as const;
const NOT_SENT_NO_CHANNEL = { line: "Not sent: no channel is set up.", notSent: "no_channel" } as const;
const NOT_SENT_LIMIT = { line: "Not sent: the hourly limit is reached.", notSent: "limit" } as const;

/** What a notice is about: its key (one notice per key at a time) and the
 *  app route it opens. */
export interface MatterRef {
  key: string;
  link: string;
}

export interface NotifyRequest {
  source: NotificationSource;
  matter: MatterRef;
  title: string;
  text: string;
  level: NotificationLevel;
  /** The channels the personal agent named, by their names; absent: Mandate chooses. */
  channels?: readonly string[];
}

/** What the sender is told: the line, and why nothing went when nothing did
 *  ("channel": a name it gave is no channel, or one turned off). */
export interface NotifyOutcome {
  line: string;
  notSent?: "looking" | "held" | "no_channel" | "limit" | "channel";
}

/** A channel the personal agent can name: Mandate's own windows, or one the user set up. */
export interface ChannelChoice {
  name: string;
  /** What it is: the kind's label, or where the windows show it. */
  about: string;
  /** Off: turned off in Settings, or not yet able to send. */
  on: boolean;
}

type Choice = ChannelChoice & { shell?: "browser" | "desktop-app"; external?: External };

export interface NotificationServiceDeps {
  store: NotificationStore;
  presence: PresenceBook;
  sse: Pick<AgentSseEmitter, "emit">;
  getConfig: () => Pick<Config, "notifications">;
  http: HttpClient;
  /** The thread that owns a worker, for its link and its page. */
  owners: (workerId: string) => string | null;
  /** Whether "Waiting on you" lists the matter (what the New thread page
   *  shows). Absent: nothing is listed. */
  listed?: (matterKey: string) => boolean;
  now?: () => Date;
  kinds?: readonly ChannelKind[];
}

type External = { channel: NotificationChannelConfig; kind: ChannelKind };
/** Where a plan sends now: the windows, and the external channels. */
type Reach = { windows: string[]; channels: External[] };
type ExternalResult = { sent: string[]; failed: Array<{ name: string; error: string }> };

/**
 * Routes each notice: nothing while the user looks at its matter,
 * a toast in the windows in use, else system notifications on the desktop
 * windows that can show them and the external channels — now when the user
 * is away, after ESCALATE_AFTER_MS when they are at the desk. One notice per
 * matter: a newer one replaces it where the channel can; a notice seen or
 * settled is taken back where the channel can. Channels the personal agent names
 * (where the user asked to be told) get it now instead, and keep it once seen.
 */
export class NotificationService {
  private readonly now: () => Date;
  private readonly kinds: readonly ChannelKind[];
  private readonly pending = new Set<Promise<unknown>>();
  /** Sending, escalating and closing go one at a time: a matter closed
   *  while its notice is still on its way is closed once it has landed, and
   *  a call made while another sends sees what that one sent. */
  private queue: Promise<unknown> = Promise.resolve();
  private ticking = false;
  private readonly startedAt: number;

  constructor(private readonly deps: NotificationServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.kinds = deps.kinds ?? CHANNEL_KINDS;
    this.startedAt = this.now().getTime();
  }

  /** On while a channel can send, the desktop app's switch is on, or a
   *  desktop browser window can show a notification. */
  isOn(): boolean {
    const config = this.deps.getConfig().notifications;
    if (config.desktopApp || this.readyChannels(config).length > 0) return true;
    return this.deps.presence.live(this.now()).some((w) => w.device === "desktop" && w.shell === "browser" && w.canShowSystem);
  }

  /** Whether a window in use (visible, focused, touched lately) shows the
   *  thread's own page with its chat in sight: the user is in it now, and
   *  what it says is in front of them. A window that does not say (its chat
   *  behind the worker panel, or a page from before it said so) is not. */
  userInThread(threadId: string): boolean {
    const now = this.now();
    return this.deps.presence.live(now).some((client) => windowInUse(client, now) && client.threadChat === threadId
      && matterShownBy(client.path, `thread:${threadId}`, this.deps.owners, () => false));
  }

  /** The matters a settling would still take something back from: notices
   *  neither seen, settled nor replaced, and named ones kept once seen. */
  openMatterKeys(): string[] {
    return this.deps.store.settleableMatterKeys();
  }

  notify(request: NotifyRequest): Promise<NotifyOutcome> {
    return this.inTurn(() => this.route(request));
  }

  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async route(request: NotifyRequest): Promise<NotifyOutcome> {
    const now = this.now();
    const { store } = this.deps;
    const key = request.matter.key;
    const named = request.channels && request.channels.length > 0 ? this.pick(request.channels) : null;
    if (named && !Array.isArray(named)) return named;
    // A repeat while the earlier words are the matter's newest and still
    // unseen, sent to the same channels (or both left to Mandate).
    const repeat = store.lastWithSameText(key, request.title, request.text, new Date(now.getTime() - DUPLICATE_WINDOW_MS).toISOString());
    if (repeat?.line && !repeat.seenAt && !repeat.settledAt && store.latestFor(key)?.id === repeat.id
      && sameNames(repeat.namedChannels, named ? [...new Set(named.map((choice) => choice.name))] : null)) return outcomeOf(repeat.line);
    if (named) return this.sendNamed(request, named);
    return (await this.dispatch(request, now, true)).outcome;
  }

  /** Mandate's choice of where a notice goes now, and the notice recorded
   *  (replacing the matter's open one) unless it can go nowhere. A notice
   *  that waited goes this way at the end of its wait, not held again. */
  private async dispatch(request: NotifyRequest, now: Date, hold: boolean): Promise<{ outcome: NotifyOutcome; row: NotificationRow | null }> {
    const { store } = this.deps;
    const key = request.matter.key;
    if (!this.isOn()) return { outcome: NOT_SENT_NO_CHANNEL, row: null };
    const live = this.deps.presence.live(now);
    const plan = this.plan(key, live, now, hold);
    const reach = this.reach(plan);
    if (plan.kind !== "looking" && plan.kind !== "held" && reach.windows.length === 0 && reach.channels.length === 0) return { outcome: NOT_SENT_NO_CHANNEL, row: null };
    // Every channel paused for the hour, and no window: nothing to record.
    if (reach.windows.length === 0 && reach.channels.length > 0 && reach.channels.every(({ channel }) => this.paused(channel.id, now))) return { outcome: NOT_SENT_LIMIT, row: null };

    const previous = store.latestOpen(key);
    const later = laterTurn(plan, reach, now);
    const row = store.insert({
      matterKey: key,
      source: request.source,
      level: request.level,
      title: request.title,
      body: request.text,
      link: request.matter.link,
      escalateAt: later ? later.toISOString() : null
    });
    if (previous) store.supersede(previous.id, row.id);
    return { outcome: await this.deliver(row, plan, reach, live, now), row };
  }

  /** What a plan sends now: nothing while the user looks or it waits; a
   *  toast in the windows in use; else system notifications, and the
   *  external channels now when the user is away (at the desk they are named,
   *  their turn comes later). */
  private async deliver(row: NotificationRow, plan: DeliveryPlan, reach: Reach, live: ReturnType<PresenceBook["live"]>, now: Date): Promise<NotifyOutcome> {
    const { store } = this.deps;
    if (plan.kind === "looking" || plan.kind === "held") {
      const outcome = plan.kind === "looking" ? NOT_SENT_LOOKING : NOT_SENT_HELD;
      store.setLine(row.id, outcome.line);
      return outcome;
    }
    const { windows, channels } = reach;
    if (windows.length > 0) {
      this.deps.sse.emit(SSE_EVENTS.notificationShow, {
        key: row.matterKey, title: row.title, body: row.body, link: row.link, level: row.level,
        toast: plan.kind === "in-use" ? windows : [],
        system: plan.kind === "in-use" ? [] : windows
      });
      store.recordSend(row.id, plan.kind === "in-use" ? TOAST_CHANNEL : WINDOWS_CHANNEL, { state: "sent", ref: null, error: null });
    }
    const windowNames = [...new Set(windows.map((id) => (live.find((w) => w.windowId === id)?.shell === "desktop-app" ? DESKTOP_APP : BROWSER)))];
    let external: ExternalResult = { sent: [], failed: [] };
    if (plan.kind === "away") external = await this.sendExternal(row, channels);
    // At the desk the channels' turn comes later: named as where it goes.
    if (plan.kind === "desk") external.sent = channels.filter(({ channel }) => !this.paused(channel.id, now)).map(({ channel }) => channel.name);
    const outcome = compose([...windowNames, ...external.sent], external.failed);
    store.setLine(row.id, outcome.line);
    return outcome;
  }

  /** Where a plan sends now. */
  private reach(plan: DeliveryPlan): Reach {
    if (plan.kind === "looking" || plan.kind === "held") return { windows: [], channels: [] };
    if (plan.kind === "in-use") return { windows: plan.toast, channels: [] };
    return { windows: plan.system, channels: this.readyChannels(this.deps.getConfig().notifications) };
  }

  /** A notice that waited for the user to see it on a page on screen, not
   *  seen: it goes now as one sent now would, where the user is now deciding
   *  (a toast where they work, the desk's wait for the phone). As a notice
   *  of now, replacing the waiting one: what the user did during the wait
   *  does not count as having seen it. With nowhere to go now, none is
   *  recorded, and the waiting one keeps no line: the same words sent again
   *  go where they can. */
  private async release(held: NotificationRow, now: Date): Promise<void> {
    const request: NotifyRequest = { source: held.source, matter: { key: held.matterKey, link: held.link }, title: held.title, text: held.body, level: held.level };
    const { row } = await this.dispatch(request, now, false);
    if (!row) this.deps.store.setLine(held.id, null);
  }

  /** The channels the personal agent can name, as its context lists them: none
   *  until the user has set one up (a channel, or the desktop app's switch);
   *  then Mandate's windows first. */
  channelChoices(): ChannelChoice[] {
    return this.choices().map(({ name, about, on }) => ({ name, about, on }));
  }

  private choices(): Choice[] {
    const config = this.deps.getConfig().notifications;
    const external = config.channels.flatMap((channel): Choice[] => {
      const kind = this.kinds.find((k) => k.id === channel.kind);
      if (!kind) return [];
      const on = channel.enabled && kind.ready(channel);
      return [{ name: channel.name, about: kind.label, on, ...(on ? { external: { channel, kind } } : {}) }];
    });
    if (external.length === 0 && !config.desktopApp) return [];
    return [
      { name: BROWSER, about: "Mandate's open browser windows: a system notification where allowed, otherwise a pop-up in the page", on: true, shell: "browser" },
      ...(config.desktopApp ? [{ name: DESKTOP_APP, about: "a system notification from Mandate's desktop app", on: true, shell: "desktop-app" as const }] : []),
      ...external
    ];
  }

  /** The channels named, in the order named; or why nothing can go. A
   *  name two channels share (Settings allows it) is each one turned on. */
  private pick(names: readonly string[]): Choice[] | NotifyOutcome {
    const choices = this.choices();
    if (choices.length === 0) return NOT_SENT_NO_CHANNEL;
    const picked: Choice[] = [];
    for (const name of names) {
      const matching = choices.filter((c) => c.name.toLowerCase() === name.toLowerCase());
      if (matching.length === 0) return { line: `No channel named "${name}". Channels: ${[...new Set(choices.map((c) => c.name))].join(", ")}.`, notSent: "channel" };
      const on = matching.filter((c) => c.on);
      if (on.length === 0) return { line: `${matching[0]!.name} is off in Settings; nothing was sent.`, notSent: "channel" };
      for (const choice of on) if (!picked.includes(choice)) picked.push(choice);
    }
    return picked;
  }

  /** Where the user asked: now, wherever they are, with no later turn. */
  private async sendNamed(request: NotifyRequest, picked: readonly Choice[]): Promise<NotifyOutcome> {
    const now = this.now();
    const { store } = this.deps;
    const live = this.deps.presence.live(now);
    const toast: string[] = [];
    const system: string[] = [];
    const shown: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    for (const choice of picked) {
      if (!choice.shell) continue;
      const windows = live.filter((w) => w.shell === choice.shell);
      if (windows.length === 0) {
        failed.push({ name: choice.name, error: "no Mandate window is open" });
        continue;
      }
      for (const w of windows) (w.device === "desktop" && w.canShowSystem ? system : toast).push(w.windowId);
      shown.push(choice.name);
    }
    const channels = picked.flatMap((choice) => (choice.external ? [choice.external] : []));
    // Nowhere to go: nothing is recorded, and what the matter waits on stays.
    if (shown.length === 0 && channels.length === 0) return compose([], failed);
    if (shown.length === 0 && channels.every(({ channel }) => this.paused(channel.id, now))) return NOT_SENT_LIMIT;

    const previous = store.latestOpen(request.matter.key);
    const row = store.insert({
      matterKey: request.matter.key,
      source: request.source,
      level: request.level,
      title: request.title,
      body: request.text,
      link: request.matter.link,
      namedChannels: [...new Set(picked.map((choice) => choice.name))]
    });
    if (previous) store.supersede(previous.id, row.id);
    if (shown.length > 0) {
      this.deps.sse.emit(SSE_EVENTS.notificationShow, { key: row.matterKey, title: row.title, body: row.body, link: row.link, level: row.level, toast, system });
      if (system.length > 0) store.recordSend(row.id, WINDOWS_CHANNEL, { state: "sent", ref: null, error: null });
      if (toast.length > 0) store.recordSend(row.id, TOAST_CHANNEL, { state: "sent", ref: null, error: null });
    }
    const external: ExternalResult = channels.length > 0 ? await this.sendExternal(row, channels) : { sent: [], failed: [] };
    const outcome = compose([...shown, ...external.sent], [...failed, ...external.failed]);
    store.setLine(row.id, outcome.line);
    return outcome;
  }

  /** A window said where it is. One in use on a matter's page has seen it. */
  reportPresence(report: PresenceReport): void {
    const now = this.now();
    this.deps.presence.report(report, now);
    if (report.gone || !report.lastInputAt) return;
    const touched = Date.parse(report.lastInputAt);
    const inUse = windowInUse(report, now);
    for (const row of this.deps.store.openMatters()) {
      if (touched <= Date.parse(row.createdAt)) continue;
      // Seen: shown in a window in use, touched after the notice came — not
      // only open there. Touched anywhere in Mandate since (a report may come
      // as the window loses focus): the user was back, and its phone send
      // waits no longer (its matter is in Waiting on you). One still waiting
      // for the user to see it goes at its time all the same: where they are
      // then decides (a toast where they work).
      if (inUse && matterShownBy(report.path, row.matterKey, this.deps.owners, this.listed)) void this.track(this.inTurn(() => this.close(row.matterKey, "seen")));
      else if (row.escalateAt && row.line !== NOT_SENT_HELD.line) this.deps.store.clearEscalation(row.id);
    }
  }

  /** The matter no longer waits on the user: its notices are taken back. */
  settle(matterKey: string): Promise<void> {
    return this.track(this.inTurn(() => this.close(matterKey, "settled")));
  }

  /** External sends that waited for the user at the desk, now due. */
  tick(): Promise<void> {
    return this.inTurn(() => this.escalate());
  }

  private async escalate(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const config = this.deps.getConfig().notifications;
      const now = this.now();
      // Due ones wait for the next tick: nobody has said where they are yet.
      if (now.getTime() - this.startedAt < STARTUP_GRACE_MS) return;
      for (const row of this.deps.store.dueEscalations(now)) {
        this.deps.store.clearEscalation(row.id);
        const live = this.deps.presence.live(now);
        if (row.line === NOT_SENT_HELD.line) {
          await this.release(row, now);
          continue;
        }
        // In Mandate since the notice, or now: the user is here, the phone
        // stays quiet.
        const since = Date.parse(row.createdAt);
        if (live.some((w) => w.lastInputAt !== null && Date.parse(w.lastInputAt) > since)) continue;
        const plan = this.plan(row.matterKey, live, now, false);
        if (plan.kind !== "desk" && plan.kind !== "away") continue;
        // A notice first shown only in the window in use: its system
        // notifications too.
        if (plan.system.length > 0 && !this.deps.store.sendsOf(row.id).some((send) => send.channelId === WINDOWS_CHANNEL)) {
          this.deps.sse.emit(SSE_EVENTS.notificationShow, {
            key: row.matterKey, title: row.title, body: row.body, link: row.link, level: row.level, toast: [], system: plan.system
          });
          this.deps.store.recordSend(row.id, WINDOWS_CHANNEL, { state: "sent", ref: null, error: null });
        }
        const channels = this.readyChannels(config);
        if (channels.length > 0) await this.sendExternal(row, channels);
      }
    } finally {
      this.ticking = false;
    }
  }

  start(): () => void {
    const timer = setInterval(() => {
      this.tick().catch((err: unknown) => logError("notifications-tick", err));
    }, TICK_MS);
    return () => clearInterval(timer);
  }

  /** Resolves once the closings started by presence reports are done. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private track(work: Promise<void>): Promise<void> {
    const kept = work.catch((err: unknown) => logError("notifications-withdraw", err));
    this.pending.add(kept);
    void kept.finally(() => this.pending.delete(kept));
    return kept;
  }

  /** Sends the test notice to a saved channel, or to one as the page has it
   *  (a blank secret there is the saved one's). */
  async test(input: unknown): Promise<NotificationTestResponse> {
    const { channel, kind } = this.resolveChannel(input);
    const outcome = await kind.send(this.context(), channel, {
      key: "test", level: "needs_you", title: "Test from Mandate", text: "Notifications reach you here.", url: null
    });
    return outcome.ok ? { ok: true, sentAt: this.now().toISOString() } : { ok: false, error: outcome.error };
  }

  /** Finds the chat the user opened with their bot; a blank token is the
   *  saved channel's. */
  async connectTelegram(input: unknown): Promise<TelegramConnectResponse> {
    const body = (input ?? {}) as { channelId?: unknown; botToken?: unknown };
    const typed = typeof body.botToken === "string" ? body.botToken.trim() : "";
    const saved = typeof body.channelId === "string" ? this.savedChannel(body.channelId)?.values.botToken ?? "" : "";
    return connectTelegram(this.context(), typed || saved);
  }

  private readonly listed = (matterKey: string): boolean => this.deps.listed?.(matterKey) ?? false;

  private plan(matterKey: string, clients: ReturnType<PresenceBook["live"]>, now: Date, hold = true): DeliveryPlan {
    const config = this.deps.getConfig().notifications;
    return planDelivery({ matterKey, clients, now, desktopAppOn: config.desktopApp, owners: this.deps.owners, listed: this.listed, hold });
  }

  private readyChannels(config: Config["notifications"]): External[] {
    return config.channels.flatMap((channel) => {
      const kind = this.kinds.find((k) => k.id === channel.kind);
      return channel.enabled && kind?.ready(channel) ? [{ channel, kind }] : [];
    });
  }

  private sentThisHour(channelId: string, now: Date): number {
    return this.deps.store.externalSendsSince(channelId, new Date(now.getTime() - HOUR_MS).toISOString());
  }

  /** Past its hour's notices and already told so: nothing more goes until a
   *  send of the last hour ages out. */
  private paused(channelId: string, now: Date): boolean {
    const since = new Date(now.getTime() - HOUR_MS).toISOString();
    return this.sentThisHour(channelId, now) >= HOURLY_CAP && this.deps.store.lastSummarySince(channelId, since) !== null;
  }

  private context(): ChannelContext {
    return { http: this.deps.http, config: this.deps.getConfig().notifications as Config["notifications"] };
  }

  /** Sends the notice to each channel: in place of what its matter already
   *  shows there, where the channel can, else anew. */
  private async sendExternal(row: NotificationRow, channels: readonly External[]): Promise<ExternalResult> {
    const result: ExternalResult = { sent: [], failed: [] };
    const now = this.now();
    const config = this.deps.getConfig().notifications;
    const url = config.linkBase ? `${config.linkBase}${row.link}` : null;
    const live = this.deps.store.liveSends(row.matterKey);
    for (const { channel, kind } of channels) {
      if (this.paused(channel.id, now)) continue;
      if (this.sentThisHour(channel.id, now) >= HOURLY_CAP) {
        // Its last one this hour says so; it is never replaced or taken back.
        const oldest = this.deps.store.oldestExternalSendSince(channel.id, new Date(now.getTime() - HOUR_MS).toISOString());
        const until = new Date((oldest ? Date.parse(oldest) : now.getTime()) + HOUR_MS);
        const more = await kind.send(this.context(), channel, {
          key: row.matterKey, level: "news", title: "More in Mandate",
          text: `Notifications here are paused until ${clockTime(until)}.`, url: config.linkBase ? `${config.linkBase}/home` : null
        });
        this.deps.store.recordSend(row.id, channel.id, more.ok ? { state: "sent", ref: null, error: null, summary: true } : { state: "failed", ref: null, error: more.error, summary: true });
        if (!more.ok) this.failed(result, channel, more.error);
        continue;
      }
      const notice: OutgoingNotification = { key: row.matterKey, level: row.level, title: row.title, text: channel.includeText ? channelNoticeText({ key: row.matterKey, body: row.body }) : "", url };
      let earlier = kind.replace ? live.find((send) => send.channelId === channel.id) : undefined;
      // A notice that needs the user is a new message, which alerts (an edit
      // does not): the earlier one is taken back first, one per matter.
      if (earlier?.ref && row.level === "needs_you" && kind.withdraw) {
        const gone = await kind.withdraw(this.context(), channel, earlier.ref);
        if (gone.ok) this.deps.store.markWithdrawn(channel.id, earlier.ref);
        earlier = undefined;
      }
      let outcome = earlier?.ref && kind.replace ? await kind.replace(this.context(), channel, earlier.ref, notice) : await kind.send(this.context(), channel, notice);
      // The earlier message could not be changed (too old, deleted): a new one.
      if (!outcome.ok && earlier) outcome = await kind.send(this.context(), channel, notice);
      if (outcome.ok) {
        this.deps.store.recordSend(row.id, channel.id, { state: "sent", ref: outcome.ref, error: null });
        result.sent.push(channel.name);
      } else {
        this.deps.store.recordSend(row.id, channel.id, { state: "failed", ref: null, error: outcome.error });
        this.failed(result, channel, outcome.error);
      }
    }
    return result;
  }

  /** A channel that failed: told to the sender, and logged (a desk notice's
   *  channels send after its sender was answered). Errors carry no secret. */
  private failed(result: ExternalResult, channel: NotificationChannelConfig, error: string): void {
    result.failed.push({ name: channel.name, error });
    logError("notifications-send", new Error(`${channel.name}: ${error}`));
  }

  /** Marks the matter's open notices, tells the windows to close them, and
   *  takes back what the matter still shows on the channels that can — the
   *  messages of earlier notices on it included. */
  private async close(matterKey: string, how: "seen" | "settled"): Promise<void> {
    const { store } = this.deps;
    const at = this.now().toISOString();
    const ids = how === "seen" ? store.markSeen(matterKey, at) : store.markSettled(matterKey, at);
    if (ids.length === 0) return;
    // Seen, a notice sent where the user asked stays there: in the windows
    // when the newest they were shown was named (one that went nowhere does
    // not replace it); on a channel, a message whose newest notice was named
    // (an edit in place shares one message between notices).
    const named = (notificationId: string) => how === "seen" && store.get(notificationId)?.namedChannels != null;
    const shownLast = store.latestWithSend(matterKey, [WINDOWS_CHANNEL, TOAST_CHANNEL]);
    if (!(shownLast && named(shownLast.id))) {
      this.deps.sse.emit(SSE_EVENTS.notificationWithdraw, { key: matterKey });
    }
    const config = this.deps.getConfig().notifications;
    const done = new Set<string>();
    // Newest first: the first send of each message is its newest notice's.
    for (const send of store.liveSends(matterKey)) {
      const once = `${send.channelId}\n${send.ref}`;
      if (done.has(once) || !send.ref) continue;
      done.add(once);
      if (named(send.notificationId)) continue;
      const channel = config.channels.find((c) => c.id === send.channelId);
      const kind = channel ? this.kinds.find((k) => k.id === channel.kind) : undefined;
      if (!channel || !kind?.withdraw) continue;
      const outcome = await kind.withdraw(this.context(), channel, send.ref);
      if (outcome.ok) this.deps.store.markWithdrawn(channel.id, send.ref);
      else logError("notifications-withdraw", new Error(`${channel.name}: ${outcome.error}`));
    }
  }

  private savedChannel(id: string): NotificationChannelConfig | null {
    return this.deps.getConfig().notifications.channels.find((channel) => channel.id === id) ?? null;
  }

  private resolveChannel(input: unknown): External {
    const body = (input ?? {}) as { channelId?: unknown; channel?: unknown };
    if (typeof body.channelId === "string") {
      const channel = this.savedChannel(body.channelId);
      const kind = channel ? this.kinds.find((k) => k.id === channel.kind) : undefined;
      if (!channel || !kind) throw new Error(`no notification channel ${body.channelId}`);
      return { channel, kind };
    }
    const patch = body.channel as NotificationChannelPatch | undefined;
    const kind = patch ? this.kinds.find((k) => k.id === patch.kind) : undefined;
    if (!patch || !kind || typeof patch.values !== "object" || patch.values === null) throw new Error("a channel to test is needed");
    const saved = typeof patch.id === "string" ? this.savedChannel(patch.id) : null;
    const values: Record<string, string> = saved && saved.kind === kind.id ? { ...saved.values } : {};
    for (const [valueKey, value] of Object.entries(patch.values)) {
      if (value === null) delete values[valueKey];
      else if (typeof value === "string" && value.trim()) values[valueKey] = value.trim();
      else if (!kind.secretKeys.includes(valueKey)) delete values[valueKey];
    }
    return {
      kind,
      channel: { id: saved?.id ?? "test", kind: kind.id, name: String(patch.name ?? ""), enabled: true, includeText: patch.includeText !== false, values }
    };
  }
}

/** The same channels named, in any order; or none named by either. */
function sameNames(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}

function compose(sent: readonly string[], failed: ReadonlyArray<{ name: string; error: string }>): NotifyOutcome {
  const parts = [
    ...(sent.length > 0 ? [`Sent to: ${sent.join(", ")}.`] : []),
    ...failed.map(({ name, error }) => `Failed: ${name} (${error}).`)
  ];
  return parts.length > 0 ? { line: parts.join(" ") } : NOT_SENT_LIMIT;
}

/** When a notice's later turn comes: the fallback of one shown nowhere or
 *  only as a toast (the window may have been left since), the end of a wait,
 *  the desk's wait for the channels. */
function laterTurn(plan: DeliveryPlan, reach: Reach, now: Date): Date | null {
  if (plan.kind === "looking" || plan.kind === "in-use") return new Date(now.getTime() + ESCALATE_AFTER_MS);
  if (plan.kind === "held") return plan.until;
  return plan.kind === "desk" && reach.channels.length > 0 ? plan.externalAt : null;
}

function outcomeOf(line: string): NotifyOutcome {
  for (const known of [NOT_SENT_LOOKING, NOT_SENT_HELD, NOT_SENT_NO_CHANNEL, NOT_SENT_LIMIT]) {
    if (line === known.line) return known;
  }
  return { line };
}

/** HH:MM on this machine's clock. */
function clockTime(at: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}
