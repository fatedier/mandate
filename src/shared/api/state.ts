/** The tmux poll's latest failure, as the banner shows it. */
export interface AppStateErrorDto {
  message: string;
  at: string;
}

/** GET /api/info: the server is up. */
export type AppInfoResponse = { ok: true };
