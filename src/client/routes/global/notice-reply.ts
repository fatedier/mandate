import { NO_TEXT_REPLY, type GlobalHandoffDto } from "@shared/api/global-agent";

/** What the target of a notice said when it stopped, as the page can show it.
 *
 *  `loading`: the page does not hold the notice's records yet.
 *  `said`: its reply, whole as the record keeps it.
 *  `silent`: it wrote nothing; `reason` is why the wait ended when it failed.
 *
 *  In each `at` is when it stopped. */
export type NoticeReply =
  | { state: "loading" }
  | { state: "said"; text: string; at: string | null }
  | { state: "silent"; reason: string | null; at: string | null };

/** One notice ends every wait on its target, oldest first, and each wait
 *  heard only what was said after it began: the newest that heard something
 *  holds what the notice told the agent. Until every record is here, one
 *  that heard nothing does not settle it.
 *
 *  A record counts once it has ended. The page can hold one as it stood
 *  while the wait was open (read when the page opened, the stop missed while
 *  the event stream was down): that copy says nothing of what was said. */
export function noticeReplyOf(handoffIds: readonly string[], handoffs: ReadonlyMap<string, GlobalHandoffDto>): NoticeReply {
  const held = handoffIds.map((id) => handoffs.get(id)).filter((h): h is GlobalHandoffDto => h !== undefined && h.repliedAt !== null);
  const heard = held.findLast((h) => h.reply !== null && h.reply !== NO_TEXT_REPLY);
  if (heard) return { state: "said", text: heard.reply!, at: heard.repliedAt };
  const last = held.at(-1);
  if (!last || held.length < handoffIds.length) return { state: "loading" };
  return { state: "silent", reason: held.findLast((h) => h.reason !== null)?.reason ?? null, at: last.repliedAt };
}
