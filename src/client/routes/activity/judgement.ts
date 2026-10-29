import type { JudgementNotUsed, JudgementRecordDto, JudgementSubjectDto } from "@shared/api-contracts";
import { isRecord } from "@shared/guards";

const NOT_USED: readonly string[] = ["stopped", "newer_reply", "question_open", "newer_verdict", "archived", "memory_changed"] satisfies JudgementNotUsed[];

/** A judgement's answer, as its call's metadata keeps it (`judgement`): read
 *  only when it holds an answer among its choices and the reply or memory it
 *  was about. Odds that are not each between 0 and 1, or a reason this screen
 *  cannot read, are left out. */
export function judgementOf(metadata: unknown): JudgementRecordDto | null {
  const record = isRecord(metadata) ? metadata.judgement : null;
  if (!isRecord(record)) return null;
  const { options, answer, subject, probabilities, notUsed } = record;
  if (!Array.isArray(options) || !options.every((option): option is string => typeof option === "string")) return null;
  if (typeof answer !== "string" || !options.includes(answer)) return null;
  const about = subjectOf(subject);
  if (!about) return null;
  const odds = isRecord(probabilities) && Object.values(probabilities).every((p) => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1)
    ? probabilities as Record<string, number>
    : undefined;
  return {
    options,
    answer,
    ...(odds ? { probabilities: odds } : {}),
    subject: about,
    ...(typeof notUsed === "string" && NOT_USED.includes(notUsed) ? { notUsed: notUsed as JudgementNotUsed } : {})
  };
}

/** A manager check's reply (and request), or a memory repeat check's memory
 *  and the stored ones it was read beside; null when it is neither. */
function subjectOf(subject: unknown): JudgementSubjectDto | null {
  if (!isRecord(subject)) return null;
  if (typeof subject.memory === "string") {
    const similar = subject.similar;
    return Array.isArray(similar) && similar.every((id): id is string => typeof id === "string") ? { memory: subject.memory, similar } : null;
  }
  if (typeof subject.replySeq !== "number" || typeof subject.replyAt !== "string") return null;
  return {
    replySeq: subject.replySeq,
    replyAt: subject.replyAt,
    ...(typeof subject.handoffId === "string" ? { handoffId: subject.handoffId } : {}),
    ...(typeof subject.requestAt === "string" ? { requestAt: subject.requestAt } : {})
  };
}
