/**
 * The addressable blocks of a canvas, and the removal of one.
 *
 * A canvas is maintained like a source file — measured across assistant
 * messages touching canvas paths, 4,412 `edit` calls against 438 `write`.
 * Inserting a block anchors on any nearby tag; removing one means matching the
 * whole block exactly, and a wrong match breaks the page. So nothing is ever
 * removed and long-lived canvases only grow: the two largest were edited across
 * 401 and 283 hours.
 *
 * This makes removal cost what insertion costs.
 */

/**
 * Elements with no end tag must never touch the open-element stack. The HTML
 * void list is not enough: `onEndTag` also throws for self-closed foreign
 * content, and inline SVG (`<path/>`, `<stop/>`) broke 5 of 171 real canvases
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

export interface CanvasBlock {
  /** 1-based position among the container's element children — the handle
   *  `removeCanvasBlock` takes. Shifts as soon as anything is removed, which is
   *  why removal also demands the label. */
  index: number;
  tag: string;
  /**
   * What the caller passes back to prove it means this block. The first h1–h3,
   * else a prefix of the block's own text.
   *
   * The fallback is not cosmetic: 31% of blocks in 171 real canvases carry no
   * heading, and 225 blocks across 66 of them shared a label with a sibling —
   * so a stale index could land on a different block and still pass the guard.
   */
  label: string;
  /** Visible characters, markup stripped. The figure the reader is complaining
   *  about, so the outline doubles as the signal for where the bulk sits. */
  chars: number;
}

export interface CanvasOutline {
  /** `main`, or `body` when the document has no single wrapper. The indices are
   *  meaningless without it. */
  container: string;
  blocks: CanvasBlock[];
  totalChars: number;
}

interface OpenNode {
  tag: string;
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
 * level is only known once body has been read — 93 of 97 canvases wrap
 * everything in a single `<main>`, and 4 do not.
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
          tag, text: [], heading: null, headingParts: [], capturingHeading: false
        };
        if (!registerEndTag(el, () => { open.pop(); })) return;
        if (relDepth === 1) {
          bodyChildren.push(node);
        } else {
          const parentIndex = bodyChildren.length - 1;
          const siblings = grandChildren.get(parentIndex) ?? [];
          siblings.push(node);
          grandChildren.set(parentIndex, siblings);
        }
        open.push(node);
        return;
      }

      // Below the tracked levels. A heading here still names the block it sits
      // in — 70% of h2s are nested inside a div rather than being a direct
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

  await rewriter.transform(new Response(html)).text();
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
  // A block that *is* a heading names itself. 3% of container children are a
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
 * The container is the single element child of `<body>`; with none or several,
 * `<body>` itself. Reported rather than assumed, because every index is
 * relative to it.
 */
export async function canvasOutline(html: string): Promise<CanvasOutline> {
  const { bodyChildren, grandChildren } = await readShallowTree(html);

  const single = bodyChildren.length === 1 ? bodyChildren[0]! : null;
  const source = single ? (grandChildren.get(0) ?? []) : bodyChildren;
  const container = single ? single.tag : "body";
  const blocks = source.map((node, i) => toBlock(node, i + 1));

  return {
    container,
    blocks,
    totalChars: single
      ? single.text.join("").replace(/\s+/g, " ").trim().length
      : blocks.reduce((sum, b) => sum + b.chars, 0)
  };
}

export type RemoveResult =
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
    const range = outline.blocks.length ? `1-${outline.blocks.length}` : "none";
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
  const next = await new HTMLRewriter()
    .on(selector, {
      element(el) { removedCount++; el.remove(); }
    })
    .transform(new Response(html))
    .text();

  if (removedCount !== 1) {
    return { ok: false, error: `expected to remove exactly 1 block, matched ${removedCount}` };
  }
  return { ok: true, html: next, removed: target, outline: await canvasOutline(next) };
}
