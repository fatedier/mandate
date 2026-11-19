/** What each Mandate window tells the server about itself, so a notice goes
 *  where the user is. Sent on change and every PRESENCE_HEARTBEAT_MS. */
export interface PresenceReport {
  /** One per tab, kept for the tab's life. */
  windowId: string;
  device: "desktop" | "phone";
  shell: "browser" | "desktop-app";
  visible: boolean;
  focused: boolean;
  /** When the user last touched this window (ISO), null when not yet. */
  lastInputAt: string | null;
  /** The page it shows: pathname and search. */
  path: string;
  /** The manager thread whose chat it has in sight: its page, the chat not
   *  behind a maximized panel, a narrow row's panel or a phone's sheet. */
  threadChat?: string;
  /** It can show a system notification: a browser with the permission where
   *  page notifications work, or the desktop app with its plugin's. */
  canShowSystem: boolean;
  /** The window is closing. */
  gone?: true;
}

export const PRESENCE_HEARTBEAT_MS = 30_000;

/** The matter of the personal agent's own question to the user. */
export const AGENT_QUESTION_MATTER = "agent:question";
/** How a task's "ready for review" notice begins: "Ready for review: <title>". */
export const TASK_REVIEW_LEAD = "Ready for review";

/** A notice for the windows the server picked: `toast` shows it inside the
 *  window (it is in use), `system` as a system notification. Window ids. */
export interface NotificationShowEvent {
  /** The matter: a later notice with the same key replaces this one. */
  key: string;
  title: string;
  body: string;
  /** The app route it opens. */
  link: string;
  level: "needs_you" | "news";
  toast: string[];
  system: string[];
}

export interface NotificationWithdrawEvent {
  key: string;
}

export type NotificationTestResponse = { ok: true; sentAt: string } | { ok: false; error: string };
export type TelegramConnectResponse = { ok: true; chatId: string; botName: string } | { ok: false; error: string };
