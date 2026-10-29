---
name: canvas-artifact
description: How to design a Mandate report (a canvas). Load before creating a report or substantially redesigning one.
scope: [manager, worker]
---

# Designing a report

`canvas_create`'s description says what the viewer does with a page: the document it wraps around it, which hosts load, what the frame refuses, how width and theme reach it. This skill is about making a good page inside those limits.

A report is read by the one person who asked for it. Decide what it is for before deciding how it looks, and let its subject decide the look: two reports on different subjects should not be one template with the words changed.

## How much design

Most reports are working documents: an analysis, a comparison, a plan, a status. They need a clear hierarchy, careful spacing and a restrained palette, and nothing that performs: no banner filling the first screen, few decorative touches.

A few are made to be shown or kept: a landing page, a small tool, a game, something the user will pass on. Those may carry a stronger visual idea; see "When it should stand out".

When you cannot tell which this is, make the plain, well-built page. That is never wrong; a showy page sometimes is.

## Rules for every report

**Whose taste.** What the user said outranks everything here. Next comes what their project already has: a design system, a theme or tokens file, the styles of its components, notes in its agent instructions. Use those wherever they exist. Your own choices fill what is left.

**Start from the subject.** Say in one sentence what the page is about, who reads it and what it must let them do. Take the look from that subject's world: how its documents are laid out, the units it measures in, the words its people use. Put at least one such thing on the page as content, not as ornament: a real scale, a real convention, a term of the trade. Every word and number on the page is real; no placeholder text.

**Type.** Choose faces on purpose: one with character for headings, used sparingly, and a readable one for text; a third for figures or captions if the page needs it. A font comes from Google Fonts (`<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=...&display=swap">`) or is embedded as a data: URI in @font-face; anything else falls back without a word, so name a fallback stack every time. Lines of text run to about 65 characters. Pick a small set of sizes and keep to it. `text-wrap: balance` on headings, comfortable line spacing for running text, a little tracking on capitals, `font-variant-numeric: tabular-nums` where figures stand in columns.

**Colour.** Pick greys that lean a little toward the accent's hue: a dead-neutral grey looks like a default nobody chose. White or near-black grounds are fine when they are a choice. Colours that carry meaning (good, warning, critical) are a separate set from the accent.

**Design both themes.** Follow the token pattern in the contract: every colour a custom property with its light value on bare `:root`, overridden in the two dark blocks. Components read tokens only: a literal colour that suits one theme breaks the other, and a colour defined only inside a dark block is missing whenever that block does not apply. Design the dark version rather than inverting the light one: check the contrast again, and that the accent still works on its new ground. `body` takes its background from a token. A page that is one look on purpose (a poster, an arcade screen) may leave the dark blocks out, by decision, with its background and every colour set.

**Space and layout.** Space siblings with `gap` in flex or grid, not with a margin on each: margins collapse or double without telling you. Gutters, wrapping and wide content go as the contract says. A page that is a single screen takes `height: 100%` on `html` and `body`, not `100vh`, so it sits inside the safe-area padding. Things that repeat (cards, rows of label and value, badges) share their edges, baselines and padding, and keep the same part in the same place. Let content set heights, and choose a column count the items fill: no card stretched over emptiness, none alone on its row. Text that can outgrow its box wraps or scrolls inside it; cut-off text is a defect.

**Boxes.** A border, a fill, a radius and a shadow each say "this is a separate thing". Use them where that is true. The same rounded, shadowed box around everything says nothing. Big-number tiles open a page only when those numbers are what the reader came for.

**Devices that mean something.** Numbered markers, small labels over headings, dividers: use one when it tells the reader something true (the steps really do come in that order), and leave it out otherwise.

**Draw charts to scale.** One scale places the marks, the ticks and the labels, and a label names only a value the chart reaches. Chart text takes its colour from the tokens, so it reads in both themes. Nothing overlaps and nothing is cut off: an SVG's viewBox is wide enough for the labels at its edges, and each of its shapes has a fill of its own.

**Readable without doing anything.** Once the page has loaded, everything meant to be read is there. Animating a section in is fine when it starts out visible: nothing waits at `opacity: 0` for a scroll that a skimming reader never makes. Size the opening to its content, not to the viewport. A tool opens in use: with the user's data where there is some, otherwise with sample data marked as a sample, never with an empty shell.

**Dashboards and tools.** Such a page is scanned and operated, not read from the top. Summary before detail. Show state by shape as well as by number (a pill, a stripe), so that what needs attention stands out. Draw a small chart with the care you give type: a fill under the line, a faint grid, the last point marked. What can be pressed looks pressable. Tabs, filters and a table that sorts do work, but what they change is not kept and the page has no way back to the agent, so nothing the reader would miss lives only there.

**Libraries.** Usually none. When one does real work for the page (a charting library, a highlighter, React), take its UMD build from cdnjs at a pinned version, in a `<script src>` ahead of the script that uses it. Do not paste its source into the page, and do not write a stand-in for it yourself. Only scripts arrive this way (the contract names the other script hosts): a library's stylesheet has to be inlined, and the page's own CSS, scripts, images and data travel with the page.

**Words.** The words are part of the design. Write from the reader's side: name things as people know them, not as the system stores them. Use the active voice. A control says exactly what it will do. An error says what went wrong and what to do about it, with no apology and nothing vague. Choose the specific word over the clever one and short, direct sentences over compressed ones, as someone who knows the subject would say it. Leave out the mannerisms: an aside between dashes, "not this, but that", a colon before a reveal, quotation marks around a label you made up, and stock phrases like "worth noting" or "honest caveat".

**The name.** The `<title>` is how the report appears in the list beside every other one: a short name specific to its subject, or the question the page answers. The explanation goes in the page's opening lines, not after a dash in the title.

**Looks to stay away from.** Pages made without a point of view land on the same few looks: a cream page with a serif headline and a terracotta accent; a near-black page with a single acid-green or vermilion accent; a banner on white that fades from purple to blue; newspaper hairlines over dense columns; Inter or Space Grotesk picked because it is the safe face; an emoji in front of every heading; everything centred; one rounded corner on every box; a coloured bar down the side of a rounded card. If the user names a look, give them exactly that look, these included. When they ask for none, do not spend the freedom on one of these.

**Build.** Check that nothing overlaps. Closed, valid markup with double-quoted attributes. A visible state for keyboard focus, and `prefers-reduced-motion` honoured. A stable `id` on every form control. Watch selector specificity, so that one rule does not quietly undo another's spacing. For generated or decorative graphics, draw on a canvas (2D or WebGL) rather than hand-writing long SVG paths.

## Before you write

Write three lines first and keep to them: the palette, as four to six named colours with their hex values; the typefaces and what each is for; the layout idea, in a sentence or two. Every later choice of colour and type comes from those lines.

## Before you publish

You cannot see the page, so check the source against the rules a single time before `canvas_publish`. Is every colour a token that has a light value, and a dark value in each of the two dark blocks (a page that is one theme on purpose is excused)? Does `body` have a background? Is there a side gutter of 16px? Do wide tables and code sit in boxes of their own with `overflow-x: auto`? Does each chart use a single scale? Correct what you find in one go and publish. The publish answers with warnings about whatever it is able to check; deal with them and publish a second time, and stop there instead of circling your own file. If the user later says something looks broken, such as a column cut off or text they cannot read, repair that one thing and publish once more.

## In Mandate

- Put the conclusion first: the first screen answers what the reader came for, and the evidence follows.
- Write in the user's language. Keep code, commands and identifiers as they are.
- A worker puts the report's id in the note of the plan step it belongs to; the app links it from the plan.
- To change a long report, don't rewrite it: `canvas_outline` shows its top-level blocks and their size, `canvas_remove_section` drops one, `edit` changes the rest, then one `canvas_publish`.

## When it should stand out

Here the user wants a point of view, not a tidy document. Decide with an opinion, and take one real risk where it serves the work.

- One strong idea, taken from the subject and shown at the top of the page: open with the thing most characteristic of it, whether that is a line, a picture or something the reader can try.
- Let type carry the character: a pairing you would not reach for out of habit, with sizes, weights and spacing chosen so the lettering itself is part of what people remember.
- Motion where it serves the idea. One arranged moment does more than many small ones, and too much movement makes a page look machine-made.
- Carry the chosen direction all the way: a rich one needs thoroughness, a spare one needs exactness in spacing, type and detail.
- Be bold in one place and quiet around it. If the accent fights the ground, do not replace it: shift it toward a neighbouring hue, or lower its saturation.

Before building, hold the three lines of your plan against the subject. Wherever a line would suit any page of this kind, change it until it suits only this one, and say in your reply what changed and the reason for it. Then build exactly to the plan as revised.
