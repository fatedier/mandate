import { memo } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/CopyButton";
import { formatClockMinutes, formatDateTimeTitle, formatDuration } from "@/lib/format";
import { VoiceMarkerHeader } from "./VoiceMarkerHeader";
import { ChatProvenanceLine } from "./ChatProvenanceLine";
import type { ChatProvenance } from "./chatProvenance";
import type { RowActions } from "./row-actions";

export function EphemeralAssistantBubble({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-1 opacity-70">
      <VoiceMarkerHeader ephemeral />
      {text && (
        <div className="text-sm leading-[1.6] whitespace-pre-wrap break-words">{text}</div>
      )}
    </div>
  );
}

export function AssistantReplyGroup({
  provenance,
  children
}: {
  provenance: ChatProvenance;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <ChatProvenanceLine provenance={provenance} grouped />
      {children}
    </div>
  );
}

/** A drawn row, and where its time is.
 *
 *  The user's message and each turn's last reply carry theirs on a line
 *  under them, with Copy (RowActionLine). Any other row that has one (a
 *  worker's reply, the event that woke a turn) shows its clock on hover in the
 *  16px gap above it, and only that small time names the full date: a title
 *  on the whole row used to pop over whatever was being read. No hover on a
 *  touch screen: the dividers keep the time there.
 *
 *  Every row is framed, with or without either: a turn's last reply gains its
 *  line when the turn ends, and a frame appearing then would remount the row. */
export function RowFrame({ rowKey, at, actions, children }: {
  /** Its key, for telling what arrived (arriving-rows). */
  rowKey: string;
  at: string | null;
  actions: RowActions | null;
  children: ReactNode;
}) {
  return (
    // Its parts stand apart as the column's rows do (16px).
    // By its slot (globals.css): a row whose content drew nothing is hidden,
    // and the row after an action line comes 8px closer.
    <div data-slot="transcript-row" data-row-key={rowKey} className="group/row relative flex flex-col gap-4">
      {children}
      {actions && <RowActionLine {...actions} />}
      {at && <RowTime at={at} />}
    </div>
  );
}

/** The line under a message that holds its Copy and its time.
 *
 *  It is part of the row and keeps its height whether or not it shows: in the
 *  gap between two rows it shared a corner with the next row's time and fell
 *  into the transcript's bottom fade, and a line that came and went would
 *  move everything under it. With a mouse it stands 4px under its message
 *  and 8px over the row after it (that one by the row's slot, globals.css),
 *  36px from a reply to the next turn: at 10 and 16 a hidden line left a 50px
 *  hole against the 16px between a turn's own rows. A
 *  touch screen keeps 10 and 16: every line shows there, and Copy's 44px
 *  touch area needs the room. The most recent
 *  reply's always shows; an older reply's and the user's show while their
 *  row is hovered or holds keyboard focus (`:focus-visible`: a click's focus
 *  would keep the line after the pointer left). A touch screen cannot hover,
 *  so there every line shows. Memoized: a streaming reply redraws the list
 *  per delta, and the line formats a time. */
const RowActionLine = memo(function RowActionLine({ side, copy, at, label, workedMs, latest }: RowActions) {
  return (
    <div
      data-slot="row-actions"
      data-side={side}
      className={cn(
        "-mt-3 flex h-6 items-center gap-0.5 transition-opacity duration-150 ease-(--ease-ui) pointer-coarse:-mt-1.5",
        // The button's own 5px inset puts the icon on the message's edge.
        side === "end" ? "-mr-[5px] justify-end" : "-ml-[5px]",
        !latest && "opacity-0 group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100 pointer-coarse:opacity-100"
      )}
    >
      {side === "end" && <RowStamp at={at} label={null} workedMs={null} />}
      {copy !== null && <CopyButton text={copy} label="Copy message" />}
      {side === "start" && <RowStamp at={at} label={label} workedMs={workedMs} />}
    </div>
  );
});

/** A row's time on its action line; its title names the full date. Before
 *  it, for a turn that said nothing, the words that it finished: with no reply
 *  above the line, the time alone would not say what ended. After a
 *  long turn's it says how long the turn worked: while the row is hovered or
 *  holds keyboard focus, the rule an older reply's line shows by, so the two
 *  never disagree; and always on a touch screen, which can do neither (a tap
 *  to reveal it was one step too many there). */
function RowStamp({ at, label, workedMs }: { at: string; label: string | null; workedMs: number | null }) {
  const clock = formatClockMinutes(at);
  if (!clock) return null;
  return (
    <span className="whitespace-nowrap px-[5px] text-2xs tabular-nums text-faint">
      {label !== null && <span data-slot="row-label">{label}{" · "}</span>}
      <time data-slot="row-stamp" dateTime={at} title={formatDateTimeTitle(at) || undefined}>{clock}</time>
      {workedMs !== null && (
        <span
          data-slot="row-worked"
          className="opacity-0 transition-opacity duration-150 ease-(--ease-ui) group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100 pointer-coarse:opacity-100"
        >
          {" · "}Worked for {formatDuration(workedMs)}
        </span>
      )}
    </span>
  );
}

/** Memoized on its time: a streaming reply redraws the list per delta, and
 *  formatting every row's time each time cost ~100ms at 300 rows. */
const RowTime = memo(function RowTime({ at }: { at: string }) {
  const clock = formatClockMinutes(at);
  if (!clock) return null;
  return (
    <time
      data-slot="row-time"
      dateTime={at}
      title={formatDateTimeTitle(at) || undefined}
      className="absolute -top-4 right-0 h-4 text-2xs leading-4 tabular-nums text-faint opacity-0 transition-opacity duration-150 ease-(--ease-ui) group-hover/row:opacity-100 pointer-coarse:hidden"
    >
      {clock}
    </time>
  );
});

/** The transcript's only visible times (see chat-dividers.ts). Memoized, as
 *  its full-time title is formatted, and a streaming reply redraws the list
 *  per delta. */
export const ChatDateSeparator = memo(function ChatDateSeparator({ timestamp, label }: { timestamp: string; label: string }) {
  return (
    // `aria-label`, not just the text: `separator` makes its children
    // presentational, so a screen reader would announce the rule and drop the
    // time. The `<time>` stays for the machine-readable `datetime`.
    <div
      className="my-1 flex items-center gap-3 text-2xs text-faint"
      role="separator"
      aria-label={label}
    >
      <span aria-hidden className="h-px flex-1 bg-border-soft" />
      <time className="shrink-0 tabular-nums" dateTime={timestamp} title={formatDateTimeTitle(timestamp) || undefined}>
        {label}
      </time>
      <span aria-hidden className="h-px flex-1 bg-border-soft" />
    </div>
  );
});
