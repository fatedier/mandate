import type { ReactElement, ReactNode } from "react";
import { normalizeExternalHttpUrl, openInSystemBrowser } from "@/lib/open-external";
import { CUT_LINE, NOTHING_FOUND, parseFetchText, parseSearchText, type ParsedSearchResult, type WebPageText } from "@shared/web-tool-text";
import type { ToolRunRow } from "../tool-run-summary";
import { DetailSection, MarkdownBlock, MarkdownOutput, OutputBlock, ProseBlock, type DetailLayout } from "./blocks";
import { GenericDetails } from "./GenericDetails";
import { webFetchArgs, webSearchArgs } from "./parse";
import { FieldGrid, RawArguments } from "./ValueViews";

/** A web search: the answer when the search wrote one, the pages it found as
 *  links, and who found them in how long. What the model was given around
 *  them (the markers) is not shown. */
export function WebSearchDetails({ row, layout }: { row: ToolRunRow; layout: DetailLayout }) {
  const args = webSearchArgs(row.call.args);
  const failure = failed(row, layout);
  if (args && failure) return failure;
  const text = args ? resultText(row) : null;
  const parsed = text === null ? null : parseSearchText(text);
  if (!parsed) return <GenericDetails row={row} layout={layout} />;
  if (parsed === "nothing") {
    return (
      <>
        <ProseBlock text={NOTHING_FOUND} />
        <RawArguments args={row.call.args} />
      </>
    );
  }
  return (
    <>
      {parsed.answer && (
        <DetailSection label="Answer" copyText={parsed.answer}>
          <MarkdownBlock text={parsed.answer} fromWeb />
        </DetailSection>
      )}
      {/* An answer that named no pages has no list to show. */}
      {parsed.results.length > 0 && (
        <DetailSection label="Results" copyText={parsed.results.map((r) => `${r.title}\n${r.url}`).join("\n\n")}>
          <ol data-slot="web-search-results" className="flex flex-col gap-2 rounded-sm bg-code-bg p-2 text-xs">
            {parsed.results.map((result, index) => <SearchResult key={index} result={result} index={index} />)}
          </ol>
        </DetailSection>
      )}
      <div data-slot="web-search-found-by" className="text-2xs text-faint">
        Found by {parsed.backend} in {parsed.seconds} s
      </div>
      <RawArguments args={row.call.args} />
    </>
  );
}

function SearchResult({ result, index }: { result: ParsedSearchResult; index: number }) {
  const line = [hostOf(result.url), result.meta, result.excerpt].filter(Boolean).join(" · ");
  return (
    <li className="flex gap-2">
      <span className="shrink-0 tabular-nums text-faint">{index + 1}.</span>
      <div className="min-w-0">
        <WebLink href={result.url}>{result.title}</WebLink>
        <div className="text-2xs text-faint">{line}</div>
      </div>
    </li>
  );
}

/** A page read: what it says of itself, its address, how much of its text
 *  was shown, and that text — without the markers or the sentence the model
 *  was given with it. */
export function WebFetchDetails({ row, layout }: { row: ToolRunRow; layout: DetailLayout }) {
  const args = webFetchArgs(row.call.args);
  const failure = failed(row, layout);
  if (args && failure) return failure;
  const text = args ? resultText(row) : null;
  const page = text === null ? null : parseFetchText(text);
  if (!page) return <GenericDetails row={row} layout={layout} />;
  const stated = ([["Title", page.title], ["Author", page.author], ["Published", page.published], ["Site", page.site]] as const)
    .flatMap(([label, value]): Array<[string, ReactElement]> => (value ? [[label, <span>{value}</span>]] : []));
  const fields: Array<[string, ReactElement]> = [
    ...stated,
    ["Address", <WebLink href={page.finalUrl}>{page.finalUrl}</WebLink>],
    ["Shown", <span>{shown(page)}</span>]
  ];
  return (
    <>
      <DetailSection label="Page">
        <FieldGrid slot="web-fetch-page" fields={fields} />
        {page.cut && <div data-slot="web-fetch-cut" className="mt-1 text-2xs text-faint">{CUT_LINE}</div>}
      </DetailSection>
      <MarkdownOutput label="Text shown" text={page.window} document={page.window} layout={layout} fromWeb />
      <RawArguments args={row.call.args} />
    </>
  );
}

/** How much of the page's text the call showed, in the reader's numbers. */
function shown(page: WebPageText): string {
  const count = (n: number) => n.toLocaleString("en-US");
  if (page.start === 0 && page.end === page.length) return `all ${count(page.length)} characters`;
  const window = `characters ${count(page.start)}–${count(page.end)} of ${count(page.length)}`;
  return page.end < page.length ? `${window} · read on from ${count(page.end)}` : window;
}

/** A failed call: its error, then what it was asked. */
function failed(row: ToolRunRow, layout: DetailLayout) {
  if (!row.result?.isError) return null;
  return (
    <>
      <OutputBlock label="Error" text={row.result.error ?? "(no error message)"} tone="red" layout={layout} />
      <RawArguments args={row.call.args} />
    </>
  );
}

function resultText(row: ToolRunRow): string | null {
  return typeof row.result?.result === "string" ? row.result.result : null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** An address from the web as a link out of Mandate (the desktop app opens it
 *  in the system browser, as Settings' links do); text that is no http(s)
 *  address stays text. */
function WebLink({ href, children }: { href: string; children: ReactNode }) {
  const url = normalizeExternalHttpUrl(href);
  if (!url) return <span className="text-foreground">{children}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-foreground underline decoration-border underline-offset-2 transition-colors hover:decoration-foreground"
      onClick={(event) => {
        if (openInSystemBrowser(url)) event.preventDefault();
      }}
    >
      {children}
    </a>
  );
}
