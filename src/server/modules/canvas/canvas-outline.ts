/**
 * The addressable blocks of a canvas, and the removal of one.
 *
 * A canvas is maintained like a source file — across the messages that touch
 * one, `edit` calls outnumber `write` calls many times over.
 * Inserting a block anchors on any nearby tag; removing one means matching the
 * whole block exactly, and a wrong match breaks the page. So nothing is ever
 * removed and long-lived canvases only grow.
 *
 * This makes removal cost what insertion costs.
 */

import { hasOwnDocumentShell } from "./canvas-html.js";

/** Page-content-only reports (the contract; older ones are whole documents) have no <body>;
 *  they are read and edited as if wrapped in one, and unwrapped again. */
const BODY_OPEN = "<body>";
const BODY_CLOSE = "</body>";

function asDocument(html: string): string {
  return hasOwnDocumentShell(html) ? html : `${BODY_OPEN}${html}${BODY_CLOSE}`;
}

function fromDocument(original: string, doc: string): string {
  if (hasOwnDocumentShell(original)) return doc;
  return doc.startsWith(BODY_OPEN) && doc.endsWith(BODY_CLOSE) ? doc.slice(BODY_OPEN.length, -BODY_CLOSE.length) : doc;
}

/** Elements that are never a block of content: they still count for
 *  :nth-child positions, but are not listed and do not make a wrapper. */
const NON_CONTENT_TAGS = new Set(["title", "style", "script", "link", "meta", "base", "noscript", "template"]);

/**
 * Elements with no end tag must never touch the open-element stack. The HTML
 * void list is not enough: `onEndTag` also throws for self-closed foreign
 * content, and inline SVG (`<path/>`, `<stop/>`) broke canvases
 * before this was probed rather than listed.
 */
function registerEndTag(el: { onEndTag(fn: () => void): void }, fn: () => void): boolean {
  try {
    el.onEndTag(fn);
    return true;
  } catch {
    return false;
  }
}

const HEADING_TAGS = new Set(["h1", "h2", "h3"]);

/** Long enough to tell two unlabelled blocks apart, short enough to retype. */
const LABEL_FALLBACK_CHARS = 48;

interface CanvasBlock {
  /** 1-based position among the container's element children — the handle
   *  `removeCanvasBlock` takes. Shifts as soon as anything is removed, which is
   *  why removal also demands the label. */
  index: number;
  tag: string;
  /**
   * What the caller passes back to prove it means this block. The first h1–h3,
   * else a prefix of the block's own text.
   *
   * The fallback is not cosmetic: many blocks in a canvas carry no
   * heading, and those would share an empty label with a sibling —
   * so a stale index could land on a different block and still pass the guard.
   */
  label: string;
  /** Visible characters, markup stripped. The figure a page is too long by,
   *  so the outline doubles as the signal for where the bulk sits. */
  chars: number;
}

interface CanvasOutline {
  /** `main`, or `body` when the document has no single wrapper. The indices are
   *  meaningless without it. */
  container: string;
  blocks: CanvasBlock[];
  totalChars: number;
}

interface OpenNode {
  tag: string;
  content: boolean;
  text: string[];
  heading: string | null;
  headingParts: string[];
  capturingHeading: boolean;
}

/**
 * Read the shallow structure: body's element children, and each of their
 * element children.
 *
 * Both levels are collected in one pass because which of them is the section
 * level is only known once body has been read — most canvases wrap
 * everything in a single `<main>`, and a few do not.
 */
async function readShallowTree(html: string): Promise<{
  bodyChildren: OpenNode[];
  grandChildren: Map<number, OpenNode[]>;
}> {
  const bodyChildren: OpenNode[] = [];
  const grandChildren = new Map<number, OpenNode[]>();
  let inBody = false;
  /** Open tracked nodes, relative depth 1 then 2. */
  const open: OpenNode[] = [];
  /** Untracked nesting below the deepest tracked node. */
  let deep = 0;

  const rewriter = new HTMLRewriter().on("*", {
    element(el) {
      const tag = el.tagName.toLowerCase();
      if (tag === "body") {
        inBody = true;
        el.onEndTag(() => { inBody = false; });
        return;
      }
      if (!inBody) return;

      const relDepth = open.length + deep + 1;
      if (relDepth <= 2) {
        const node: OpenNode = {
          tag, content: !NON_CONTENT_TAGS.has(tag), text: [], heading: null, headingParts: [], capturingHeading: false
        };
        // A void element (<meta>, <link>, <hr>, <img>) has no end tag and no
        // children. It is never a block, but :nth-child counts it, so it
        // keeps its place among the siblings.
        const isVoid = !registerEndTag(el, () => { open.pop(); });
        if (isVoid) node.content = false;
        if (relDepth === 1) {
          bodyChildren.push(node);
        } else {
          const parentIndex = bodyChildren.length - 1;
          const siblings = grandChildren.get(parentIndex) ?? [];
          siblings.push(node);
          grandChildren.set(parentIndex, siblings);
        }
        if (!isVoid) open.push(node);
        return;
      }

      // Below the tracked levels. A heading here still names the block it sits
      // in — most h2s are nested inside a div rather than being a direct
      // child of their section.
      if (HEADING_TAGS.has(tag)) {
        for (const node of open) {
          if (node.heading === null && !node.capturingHeading) node.capturingHeading = true;
        }
        if (!registerEndTag(el, () => {
          for (const node of open) {
            if (node.capturingHeading) {
              node.heading = node.headingParts.join("").replace(/\s+/g, " ").trim();
              node.headingParts = [];
              node.capturingHeading = false;
            }
          }
          deep--;
        })) {
          for (const node of open) node.capturingHeading = false;
          return;
        }
      } else if (!registerEndTag(el, () => { deep--; })) {
        return;
      }
      deep++;
    },
    text(chunk) {
      if (!inBody || open.length === 0) return;
      for (const node of open) {
        node.text.push(chunk.text);
        if (node.capturingHeading) node.headingParts.push(chunk.text);
      }
    }
  });

  await rewriter.transform(new Response(asDocument(html))).text();
  return { bodyChildren, grandChildren };
}

/** A heading that started at a tracked depth is closed the same way. */
function finishHeading(node: OpenNode): string {
  if (node.heading !== null) return node.heading;
  const text = node.headingParts.join("").replace(/\s+/g, " ").trim();
  return text;
}

function toBlock(node: OpenNode, index: number): CanvasBlock {
  const text = node.text.join("").replace(/\s+/g, " ").trim();
  // A block that *is* a heading names itself. Some container children are a
  // bare h1, and reporting those as unnamed would make them unaddressable in
  // practice — the caller has nothing to pass as expectHeading.
  // No special case for a block that is itself a heading: the fallback below
  // already answers with its text, and a second path to the same answer is one
  // no test can hold apart.
  return {
    index,
    tag: node.tag,
    label: finishHeading(node) || text.slice(0, LABEL_FALLBACK_CHARS),
    chars: text.length
  };
}

/**
 * The container is the single content child of `<body>`; with none or several,
 * `<body>` itself. Reported rather than assumed, because every index is
 * relative to it. Title, style, script and the like are never blocks, but
 * keep their place in the index, which is an :nth-child position.
 */
export async function canvasOutline(html: string): Promise<CanvasOutline> {
  const { bodyChildren, grandChildren } = await readShallowTree(html);

  const contentChildren = bodyChildren.filter((node) => node.content);
  const singleIndex = contentChildren.length === 1 ? bodyChildren.indexOf(contentChildren[0]!) : -1;
  const single = singleIndex >= 0 ? bodyChildren[singleIndex]! : null;
  const source = single ? (grandChildren.get(singleIndex) ?? []) : bodyChildren;
  const container = single ? single.tag : "body";
  const blocks = source.flatMap((node, i) => (node.content ? [toBlock(node, i + 1)] : []));

  return {
    container,
    blocks,
    totalChars: single
      ? single.text.join("").replace(/\s+/g, " ").trim().length
      : blocks.reduce((sum, b) => sum + b.chars, 0)
  };
}

type RemoveResult =
  | { ok: true; html: string; removed: CanvasBlock; outline: CanvasOutline }
  | { ok: false; error: string };

/**
 * Remove one block by position, refusing unless its label is what the caller
 * expects.
 *
 * The guard is the point. Indices shift the moment anything is removed, and an
 * outline read a few steps ago may no longer describe the document — without
 * it, "remove block 3" run twice deletes two unrelated things.
 */
export async function removeCanvasBlock(
  html: string,
  index: number,
  expectLabel: string
): Promise<RemoveResult> {
  const outline = await canvasOutline(html);
  const target = outline.blocks.find((b) => b.index === index);
  if (!target) {
    const range = outline.blocks.length ? outline.blocks.map((b) => b.index).join(", ") : "none";
    return { ok: false, error: `no block at index ${index} (addressable: ${range})` };
  }
  const expected = expectLabel.replace(/\s+/g, " ").trim();
  if (target.label !== expected) {
    return {
      ok: false,
      error: `block ${index} is "${target.label}", not "${expected}" — ` +
        "read canvas_outline again; indices move when anything is removed"
    };
  }

  // `:nth-child` counts element children only, which is what `index` means.
  const selector = `${outline.container} > :nth-child(${index})`;
  let removedCount = 0;
  const next = fromDocument(html, await new HTMLRewriter()
    .on(selector, {
      element(el) { removedCount++; el.remove(); }
    })
    .transform(new Response(asDocument(html)))
    .text());

  if (removedCount !== 1) {
    return { ok: false, error: `expected to remove exactly 1 block, matched ${removedCount}` };
  }
  return { ok: true, html: next, removed: target, outline: await canvasOutline(next) };
}
