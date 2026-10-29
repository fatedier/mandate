import { Fragment, isValidElement, useState, type ReactElement, type ReactNode } from "react";
import { Fold } from "@/components/Fold";
import { CopyButton } from "@/components/CopyButton";
import { isRecord } from "@shared/guards";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CodeBlock, DetailSection, MarkdownBlock, type DetailLayout } from "./blocks";
import { INLINE_CAP_CHARS, INLINE_CAP_ROWS, useInlineCap } from "./inline-cap";
import { formatPayload } from "./parse";
import { argParts, humanizeKey, isScalar, isTimestamp, itemSummary, layoutRows, MAX_DEPTH, partLabel, type Scalar } from "./shape";

/** A short value as it reads best: a time as a time (its exact value in the
 *  tooltip), one token — an id, a path, a number: printable ASCII with no
 *  space — in mono, words in the body face. A name in Chinese has no spaces
 *  but is no token. Wrapped, never cut. */
function ScalarText({ value }: { value: Scalar }) {
  if (value === null) return <span className="font-mono text-faint">null</span>;
  // A time formats only after 1970; one before stays as it was written.
  if (isTimestamp(value) && formatDateTime(value)) {
    return <time dateTime={value} title={value} className="tabular-nums">{formatDateTime(value)}</time>;
  }
  const text = String(value);
  const token = typeof value !== "string" || /^[\x21-\x7e]+$/.test(value);
  return <span className={cn("whitespace-pre-wrap", token && "font-mono")}>{text}</span>;
}

/** Labels and their short values, two columns, both wrapping. A view that
 *  knows its values (a link, a name) may pass one drawn already. */
export function FieldGrid({ fields, slot }: { fields: Array<[string, Scalar | Scalar[] | ReactElement]>; slot?: string }) {
  return (
    <dl data-slot={slot} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-sm bg-code-bg p-2 text-2xs [overflow-wrap:anywhere]">
      {fields.map(([label, value]) => (
        <Fragment key={label}>
          <dt className="max-w-[10rem] text-chrome">{label}</dt>
          <dd className="min-w-0 text-foreground">
            {isValidElement(value) ? value : Array.isArray(value)
              ? (value.length === 0 ? <span className="text-faint">none</span> : value.map((item, i) => (
                  <span key={i}>{i > 0 && ", "}<ScalarText value={item} /></span>
                )))
              : <ScalarText value={value} />}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** The JSON toggle a laid-out value carries: the raw value a tap away, so
 *  nothing it carried — an exact key, a field the layout leaves out — is out
 *  of reach. */
function JsonToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className={cn("hit relative shrink-0 text-2xs transition-colors hover:text-foreground", on ? "text-foreground" : "text-chrome")}
    >
      JSON
    </button>
  );
}

/** A sub-part of a section: a small heading, and what it heads. */
function SubPart({ label, copyText, slot, children }: { label: string; copyText?: string; slot?: string; children: ReactNode }) {
  return (
    <div data-slot={slot} className="flex flex-col gap-1">
      {/* 44px tall on a touch screen, so Copy's touch area stays in it: a
          first part sits right under the section's header and its JSON. */}
      <div className="flex items-center gap-2 pointer-coarse:min-h-11">
        <span data-slot="tool-part-label" className="min-w-0 text-2xs text-chrome">{label}</span>
        {copyText !== undefined && <CopyButton text={copyText} label={`Copy ${label.toLowerCase()}`} />}
      </div>
      {children}
    </div>
  );
}

/** One call's arguments as one section, placed by shape (see argParts): the
 *  short ones in a grid, then each piece of writing, list or deeper value
 *  under a small heading of its own at full width. Copy and the JSON toggle
 *  give the arguments exactly as sent — the keys the labels were made from
 *  included, which a label can blur (`foo_bar` and `fooBar` both read "Foo
 *  bar"). */
export function ArgumentSections({ args, skip }: { args: unknown; skip?: ReadonlySet<string> }) {
  const [showJson, setShowJson] = useState(false);
  const parts = argParts(args, skip);
  if (parts.length === 0) return null;
  const raw = formatPayload(args);
  const options = parts.flatMap((part) => (part.kind === "option" ? [[partLabel(part.key), part.value] as [string, Scalar]] : []));
  return (
    <DetailSection
      label="Arguments"
      copyText={raw}
      slot="tool-args"
      actions={<JsonToggle on={showJson} onToggle={() => setShowJson((v) => !v)} />}
    >
      {showJson ? <CodeBlock text={raw} /> : (
        <div className="flex flex-col gap-2">
          {options.length > 0 && <FieldGrid fields={options} slot="tool-options" />}
          {parts.map((part) => {
            if (part.kind === "option") return null;
            const label = partLabel(part.key);
            const key = part.key.join(".");
            if (part.kind === "prose") {
              return (
                <SubPart key={key} label={label} copyText={part.value} slot="tool-arg">
                  <MarkdownBlock text={part.value} />
                </SubPart>
              );
            }
            if (part.kind === "list") {
              return (
                <SubPart key={key} label={label} copyText={part.value.join("\n")} slot="tool-arg">
                  <ItemTexts items={part.value} />
                </SubPart>
              );
            }
            const text = formatPayload(part.value);
            return (
              <SubPart key={key} label={label} copyText={text} slot="tool-arg">
                <CodeBlock text={text} />
              </SubPart>
            );
          })}
        </div>
      )}
    </DetailSection>
  );
}

/** Strings someone wrote, one per line of a list. */
function ItemTexts({ items }: { items: string[] }) {
  return (
    <ul data-slot="tool-list" className="flex flex-col gap-1 rounded-sm bg-code-bg p-2 text-xs text-foreground [overflow-wrap:anywhere]">
      {items.map((item, index) => (
        <li key={index} className="flex gap-2">
          <span aria-hidden className="select-none text-faint">•</span>
          <span className="min-w-0 whitespace-pre-wrap">{item}</span>
        </li>
      ))}
    </ul>
  );
}

/** Records as a list: each one's title, its id, and a few short fields —
 *  the line a person scans for. All of it is in the raw JSON. */
function ItemList({ items }: { items: unknown[] }) {
  return (
    <ul data-slot="tool-items" className="flex flex-col rounded-sm bg-code-bg text-2xs">
      {items.map((item, index) => {
        if (!isRecord(item)) {
          return (
            <li key={index} className="border-t border-border-soft px-2 py-1.5 first:border-t-0 [overflow-wrap:anywhere]">
              {isScalar(item) ? <ScalarText value={item} /> : <span className="font-mono">{formatPayload(item)}</span>}
            </li>
          );
        }
        const { title, id, meta } = itemSummary(item);
        // Nothing to name it by: the record itself, rather than a blank row.
        if (title === null && id === null && meta.length === 0) {
          return (
            <li key={index} className="border-t border-border-soft px-2 py-1.5 font-mono first:border-t-0 [overflow-wrap:anywhere]">
              {JSON.stringify(item)}
            </li>
          );
        }
        return (
          <li key={index} className="flex flex-col gap-0.5 border-t border-border-soft px-2 py-1.5 first:border-t-0 [overflow-wrap:anywhere]">
            {(title ?? id) !== null && (
              <span data-slot="tool-item-title" className={cn("line-clamp-3 whitespace-pre-wrap text-xs text-foreground", title === null && "font-mono")}>
                {title ?? id}
              </span>
            )}
            {(meta.length > 0 || (title !== null && id !== null)) && (
              <span data-slot="tool-item-meta" className="text-faint">
                {[
                  ...(title !== null && id !== null ? [<span key="id" className="font-mono">{id}</span>] : []),
                  ...meta.map(([key, value]) => (
                    <span key={key}>{humanizeKey(key)}: <ScalarText value={value} /></span>
                  ))
                ].map((node, i) => <span key={i}>{i > 0 && " · "}{node}</span>)}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A structured value laid out: its short fields in one grid, then each
 *  nested record and each list of records under a small heading of its own.
 *  Past two levels down a value is shown as JSON. */
function StructuredValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (Array.isArray(value)) {
    return value.length === 0 ? <div className="text-2xs text-faint">None</div> : <ItemList items={value} />;
  }
  if (!isRecord(value) || depth > MAX_DEPTH) return <CodeBlock text={formatPayload(value)} />;
  if (Object.keys(value).length === 0) return <div className="text-2xs text-faint">Empty</div>;
  const fields: Array<[string, Scalar | Scalar[]]> = [];
  const nested: Array<[string, unknown]> = [];
  for (const [key, field] of Object.entries(value)) {
    if (field === undefined) continue;
    if (isScalar(field)) fields.push([humanizeKey(key), field]);
    else if (Array.isArray(field) && field.every(isScalar)) fields.push([humanizeKey(key), field]);
    else nested.push([key, field]);
  }
  return (
    <div className="flex flex-col gap-2">
      {fields.length > 0 && <FieldGrid fields={fields} slot="tool-fields" />}
      {nested.map(([key, field]) => (
        <div key={key} data-slot="tool-nested" className="flex flex-col gap-1">
          <div className="text-2xs text-chrome">
            {humanizeKey(key)}
            {Array.isArray(field) && <span className="text-faint"> · {field.length}</span>}
          </div>
          <StructuredValue value={field} depth={depth + 1} />
        </div>
      ))}
    </div>
  );
}

/** A structured result, laid out, with its raw JSON a tap away: nothing it
 *  carried is out of reach. A failure leads with its message in red. Long,
 *  it is capped in the transcript as text output is (useInlineCap). */
export function StructuredSection({ label, tone = "plain", message, value, raw, layout }: {
  label: string;
  tone?: "plain" | "red";
  /** The error's words, shown above the rest of what came back. */
  message?: string | null;
  /** What to lay out; left out, nothing beyond the message. */
  value?: unknown;
  raw: unknown;
  layout: DetailLayout;
}) {
  const [showJson, setShowJson] = useState(false);
  const text = formatPayload(raw);
  const cap = useInlineCap(layout, text.length > INLINE_CAP_CHARS || (value !== undefined && layoutRows(value) > INLINE_CAP_ROWS));
  return (
    <DetailSection
      label={label}
      tone={tone === "red" ? "red" : "chrome"}
      copyText={text}
      slot="tool-result"
      actions={(
        <>
          {cap.toggle}
          <JsonToggle on={showJson} onToggle={() => setShowJson((v) => !v)} />
        </>
      )}
    >
      {showJson ? <div className={cap.boxClass}><CodeBlock text={text} /></div> : (
        <div data-slot="tool-result-body" className={cn("flex flex-col gap-2", cap.boxClass)}>
          {message && (
            <div data-slot="tool-output" className="whitespace-pre-wrap rounded-sm bg-red/10 p-2 text-2xs text-red [overflow-wrap:anywhere]">
              {message}
            </div>
          )}
          {value !== undefined && <StructuredValue value={value} />}
        </div>
      )}
    </DetailSection>
  );
}

/** The arguments exactly as sent, for a view that shows a call its own way:
 *  what it lays out is what it understands, and this keeps the rest — a
 *  flag, an offset, a selector it does not draw — a tap away. */
export function RawArguments({ args }: { args: unknown }) {
  const [open, setOpen] = useState(false);
  const text = formatPayload(args);
  return (
    <div data-slot="tool-raw-args" className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        // 44px tall on a touch screen: a call's details end 8px above the
        // next call, closer than a touch area centred on it would reach.
        className="hit relative self-start text-2xs text-chrome transition-colors hover:text-foreground pointer-coarse:min-h-11"
      >
        {open ? "Hide arguments" : "Show arguments"}
      </button>
      <Fold open={open}>
        <DetailSection label="Arguments" copyText={text}>
          <CodeBlock text={text} />
        </DetailSection>
      </Fold>
    </div>
  );
}
