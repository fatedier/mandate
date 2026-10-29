import { CopyButton } from "@/components/CopyButton";
import { ImageViewer } from "@/components/ImageViewer";
import { formatByteSize } from "@/lib/format";
import type { ToolImageResultContent } from "@shared/agent-message-types";
import { isRecord } from "@shared/guards";
import { callDescription, rowStatus, type ToolRunRow } from "../tool-run-summary";
import { imageSources, toolImageOf } from "../attachments";
import { DetailSection, MarkdownOutput, OutputBlock, ProseBlock, type DetailLayout } from "./blocks";
import { isBareAck } from "./shape";
import { TargetSection, type TargetKind } from "./targets";
import { ArgumentSections, StructuredSection } from "./ValueViews";


/** Any tool without a view of its own: its arguments placed by shape — the
 *  short ones in one grid, each piece of writing at full width — then what
 *  came back, laid out as fields and lists rather than a JSON dump, the raw
 *  JSON a tap away. The same in the transcript and in the phone's sheet. */
export function GenericDetails({ row, layout }: { row: ToolRunRow; layout: DetailLayout }) {
  const { call, result } = row;
  const description = callDescription(call);
  const imageResult = result && !result.isError ? toolImageOf(result.result) : null;
  const failed = rowStatus(row) === "error";
  const target = TARGETS.get(call.toolName);
  const targetId = target && isRecord(call.args) && typeof call.args[target.key] === "string" ? call.args[target.key] as string : null;
  // Shown in sections of their own, so not repeated as arguments.
  const skip = new Set([...(description ? ["description"] : []), ...(target && targetId ? [target.key] : [])]);

  return (
    <>
      {description && (
        <DetailSection label="Description">
          <ProseBlock text={description} />
        </DetailSection>
      )}
      {target && targetId && <TargetSection kind={target.kind} id={targetId} callId={call.toolCallId} />}
      <ArgumentSections args={call.args} skip={skip} />
      {result && (imageResult ? (
        <ImageResult result={imageResult} />
      ) : (
        <ResultSection row={row} failed={failed} layout={layout} markdown={MARKDOWN_RESULTS.get(call.toolName)} />
      ))}
    </>
  );
}

/** Tools that act on one pane or feature, and the argument that names it:
 *  shown by name, as the target, rather than as an id among the arguments.
 *  (spawn_pane's `targetPaneId` is the pane it splits beside, not its target.) */
const TARGETS = new Map<string, { key: string; kind: TargetKind }>([
  ["kill_pane", { key: "paneId", kind: "pane" }],
  ["set_pane_metadata", { key: "paneId", kind: "pane" }],
  ["pane_status", { key: "paneId", kind: "pane" }],
  ["feature_message_send", { key: "featureId", kind: "feature" }],
  ["get_feature_status", { key: "featureId", kind: "feature" }],
  ["read_feature_thread", { key: "featureId", kind: "feature" }],
  ["archive_feature", { key: "featureId", kind: "feature" }],
  ["restore_feature", { key: "featureId", kind: "feature" }],
  ["list_panes", { key: "featureId", kind: "feature" }]
]);

/** Tools whose text result is a markdown document, and the document in it:
 *  a skill comes wrapped in `<system-reminder>` tags addressed to the model
 *  (the tags are left off the rendering, not the Copy); a skill's reference
 *  file is returned as it is, tags it may itself contain included. */
const MARKDOWN_RESULTS = new Map<string, (text: string) => string>([
  ["skill", (text) => text.replace(/^\s*<system-reminder>\s*\n?/, "").replace(/\n?\s*<\/system-reminder>\s*$/, "")],
  ["read_skill_reference", (text) => text]
]);

function ImageResult({ result }: { result: ToolImageResultContent }) {
  const text = `${result.message}\n${result.image.mediaType}, ${formatByteSize(result.image.sizeBytes)}`;
  const { thumb, original } = imageSources(result.image);
  return (
    <DetailSection label="Output" actions={<CopyButton text={text} label="Copy output" />}>
      <div className="rounded-sm bg-code-bg p-2 text-2xs text-foreground">
        <ImageViewer
          src={original}
          alt={result.image.displayPath || result.image.name || "Viewed image"}
          className="mb-2 block w-fit overflow-hidden rounded-xs border border-border-soft bg-background/60 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
        >
          <img
            src={thumb}
            alt={result.image.displayPath || result.image.name || "Viewed image"}
            loading="lazy"
            decoding="async"
            className="max-h-48 max-w-full object-contain"
          />
        </ImageViewer>
        <div className="whitespace-pre-wrap break-words text-muted-foreground">{text}</div>
      </div>
    </DetailSection>
  );
}

/** What came back. A raised error, or an `{ error }` the tool reported, as
 *  the error's words; a bare `{ ok: true }` as nothing, since the status
 *  already says it; text as output; anything structured laid out. */
export function ResultSection({ row, failed, layout, markdown }: {
  row: ToolRunRow;
  failed: boolean;
  layout: DetailLayout;
  /** A text result is a markdown document: given the text, the document to
   *  render. */
  markdown?: (text: string) => string;
}) {
  const { result } = row;
  if (!result) return null;
  if (result.isError) {
    return <OutputBlock label="Error" text={result.error ?? "(no error message)"} tone="red" layout={layout} />;
  }
  // Text stays text, even text that reads as JSON (a file of `{"ok":true}`):
  // no stored result is JSON text, so parsing one
  // would only ever misread a text result.
  const value = result.result;
  if (!failed && (result.result === undefined || isBareAck(value))) return null;
  if (markdown && !failed && typeof value === "string") return <MarkdownOutput text={value} document={markdown(value)} layout={layout} />;
  if (typeof value === "string" || value === undefined) {
    return <OutputBlock label={failed ? "Error" : "Output"} text={value ?? ""} tone={failed ? "red" : "plain"} layout={layout} />;
  }
  if (!failed) {
    return <StructuredSection label="Output" value={isRecord(value) && value.ok === true ? without(value, ["ok"]) : value} raw={result.result} layout={layout} />;
  }
  // A failure the tool reported: its words first, then whatever else came
  // with them. `ok: false` says what the red already does.
  const message = isRecord(value) && typeof value.error === "string" ? value.error : null;
  const rest = isRecord(value) ? without(value, ["ok", "error"]) : value;
  return (
    <StructuredSection
      label="Error"
      tone="red"
      message={message}
      value={isRecord(rest) && Object.keys(rest).length === 0 ? undefined : rest}
      raw={result.result}
      layout={layout}
    />
  );
}

function without(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
