---
name: canvas-design
description: How to make a Mandate design canvas — UI screens (or other fixed-size visuals) as artboards at real sizes, for the user to compare and choose. Load before creating or revising a design canvas.
scope: [manager, worker]
---

# Design canvases

A design canvas is a surface the user pans and zooms, with artboards placed on it at their true sizes. It suits UI proposals that need comparing or approving: screens not built yet (two or three options that really differ, for phone and for desktop), or built ones (before beside after). Where a report is read, a design is looked at and chosen from.

Every artboard page falls under the page contract in `canvas_create`'s description: its skeleton, the hosts it may load from, the limits of the frame. An artboard departs from it twice. It is shown at its board's fixed size. And it is one look for every viewer: no theme reaches it, so leave out the contract's dark blocks, and when a dark version is wanted draw it as an artboard of its own with its colours written out.

## Creating

1. Call `canvas_create` with `kind: "design"`. Its `title` is what the user calls the canvas, not a stand-in such as "Design" or "Untitled". The `sourcePath` it returns is the canvas's `canvas.json`, and the artboards and the files they use live in that same folder.
2. Decide the direction before any file: the job of the screens, what already exists that they must match, and which differences between options would make the choice easier (`references/questions.md` covers when to ask and how). If the repository is available, read its real components and styles first (`references/craft.md`, "From the product"). Then choose between static and interactive, pick a single look you can name, and put your assumptions in one line.
3. Write `canvas.json` and each artboard file with the file tools, and call `canvas_publish` one time. Tell the user in a line what you made and what you took for granted.
4. **Do not check your work unless asked.** Do not render the canvas, take a screenshot of it or open it to see how it came out, and do not read your files again to check the sizes. `canvas_publish` reports warnings about what it is able to see: fix them and publish once more.

## The files: exact shapes

- **`canvas.json`** is the index: `{"v":3,"title":"Checkout redesign","launch":{"view":"canvas"},"pages":[],"boards":{"Main.html":{"x":0,"y":0,"w":390,"h":844,"title":"Cart"},"Checkout.html":{"x":470,"y":0,"w":390,"h":844,"title":"Checkout"}},"order":["Main.html","Checkout.html"],"notes":{}}`.
  - `boards` has an entry for each artboard, under the path of its file within the canvas folder. `x`, `y`, `w` and `h` give its FRAME a place and a size in the canvas's CSS px; `w` and `h` run from 40 to 8000. Keep frames 80 px apart within a row and rows 120 px apart. The optional keys: `title`, the text in the frame's name strip (the file name is used without it); `page`, the page the board is on (the first when absent); `expand`, where `"fill"` makes the artboard take the whole window and scroll when it is focused; `is_interactive`, where `true` says its controls work and puts a ▶ on the frame; `radius`, the corner in px.
  - `order` lists those paths from the back to the front. Call the first artboard `Main.html`.
  - `pages`, when present, is `[{"id","name"}]`: 40 at most, each id matching `[A-Za-z0-9_-]{1,40}`. Boards and notes that name no `page` belong to the first.
  - `launch` says how the canvas opens. `{"view":"canvas"}` opens the canvas view on the first page, and a `"page"` beside it (an id from `pages`) opens it on that page instead; either way only that page's artboards are in view. `{"view":"focused","file":"Main.html"}` opens on one artboard by itself.
  - `notes` (optional): `{"<id>":{"x":0,"y":-300,"text":"Checkout","kind":"title1","maxW":1840}}`: every note needs `x`, `y` and `text`; at most 200, with ids of the same form as page ids. With `kind` `title1` a note is a heading over a GROUP of artboards (one artboard already has its name on its frame): a single bold line at 72 px that shrinks to fit `maxW`, which you set to the width of the row beneath it. Place it at least 223 px above that row so it clears the frames' name strips. With no `kind` a note is a sticky: give it `w`, and it grows as tall as `maxH` (4/3 of `w` unless you say otherwise) before it scrolls. Either kind accepts `size` (`s|m|l|xl|xxl` or px), `bold`, `italic`, `page` and `color`; a sticky also accepts `fill` (`gray|red|orange|yellow|green|teal|blue|purple|pink`).
  - When `canvas.json` is already there, leave alone whatever you were not asked to change, keys and entries alike.
- **One `.html` file per artboard**, holding its page content. A path is made of segments joined by `/`; a segment begins with a letter, a digit or `_` and goes on with those, `.` and `-`. Spaces are not allowed, and the path ends in `.html`.
- Images and other files an artboard uses sit in the folder as well, and the artboard links them by relative path.

`canvas_publish` refuses a missing artboard file, a bad path, an index that is not JSON, and canvas.json and its artboard pages over 16 MB together (support files beside them don't count).

## One artboard

An artboard is a page written to the page contract: its content only, since the skeleton is the viewer's, with a `<style>` of its own; an artboard needs no `<title>`: its frame is named by its board's `title` in `canvas.json`. Here is a phone cart screen, `Main.html`:

```html
<style>
body { margin: 0; background: #f7f3ee; color: #231d18; font: 16px/1.45 "Avenir Next", "Segoe UI", system-ui, sans-serif; }
.screen { width: 390px; height: 844px; box-sizing: border-box; padding: 24px; display: flex; flex-direction: column; gap: 16px; }
.cta { display: block; margin-top: auto; min-height: 52px; padding: 16px; border-radius: 14px; background: #2f5d50; color: #fff; text-align: center; font-weight: 700; text-decoration: none; }
</style>
<main class="screen">
  <h1 style="margin: 0; font-size: 28px">Your cart</h1>
  <p style="margin: 0">Ethiopia Guji, 250 g · ¥98</p>
  <a class="cta" href="Checkout.html">Checkout</a>
</main>
```

Each of these goes wrong without an error:

- The root element takes a FIXED size, the same `w`×`h` as its board. Whatever is taller than `h` is cut off on the canvas, so make the board as tall as its content (too tall is better than clipped) or give a scrolling page `expand: "fill"`.
- Every colour is written out, the background included. Leave out whatever reads the system theme of the person looking: a rule or a media attribute on `prefers-color-scheme`, `light-dark()`, a `color-scheme` naming dark, a `matchMedia` query on the scheme, any of the Tailwind `dark:` classes. With one of them in the page, each person's system picks the look and two people see two designs; `canvas_publish` warns about every one. Light and dark versions are two artboards.
- Groups of siblings are spaced by `gap` in a flex or grid container.
- A static mockup still uses the real elements: `<button>`, `<a href>`, an `<input>` with its `<label>`.
- Draw icons as stroke SVG inside the page; do not use emoji for them. No `<iframe>`, `<object>` or `<embed>`, and no page-wide key listener, whether on `document` or on `window`.
- A link from one artboard to another: `<a href="Checkout.html">` takes the focused view there. The path is resolved from this artboard's own, and one that begins with `/` starts at the canvas folder. Make the `<a>` itself look like the button, because with a `<button>` inside it the click never reaches the link. An `#id` link scrolls within its artboard, and an `https://…` link opens a new tab. State is per artboard, so screens that have to share state are a single artboard with a script that shows one screen and hides the others.
- Usual sizes: a phone 390×844, a desktop 1280 to 1440 wide.

For a prototype the user can click through, give every screen its own artboard, mark each `"is_interactive": true`, and connect them with links. A design that is a single page needs only one artboard: open it focused (`{"launch":{"view":"focused","file":"Main.html"}}`), set `"expand": "fill"`, and let its root take the width it is given, so the page occupies the window and scrolls as a web page does.

## Revising

Work from the files as they are on disk, not from what you remember. Read `canvas.json` when an artboard's path is needed or the layout is changing, and read every artboard you are about to change. Touch what was asked for and nothing else, and write no file you did not change. Adding an artboard takes three things: the file, an entry in `boards`, and the path in `order`. Removing one takes the same three away. To move one, change its `x` and `y`; to rename the canvas, change `title`. End with a single `canvas_publish`.

## Designing well (in full: `references/craft.md`)

- Nothing to fill space: no padding copy, made-up figures or dummy text. Where a fact is missing, show a visible placeholder such as [YOUR PRICE]. A small request gets a small change.
- Your reasons, and your notes on each option, belong in the reply. Keep them off the artboards.
- A finished-looking design begins with the product as it is: read the repository's components, styles and tokens and use their exact values. Drawing from memory is the last thing to try.
- If the repository has no design system, settle a small one and hold to it: one to three typefaces (a display face with character above a quieter text face, loaded from Google Fonts or embedded as a data: URI), a ground with a slight tint, and at most two accents of equal chroma and lightness.
- No generic looks: gradient washes, a coloured stripe down the side of a card, emoji (unless the brand uses them), Inter, Roboto or Arial for everything. Nothing to tap is under 44px, and no status bar or keyboard is painted in.
- Accessible as drawn: text has a contrast of 4.5:1 with its background, or 3:1 at 24px and larger. Grey captions and white text on a coloured fill are the usual failures, and darker cures both. Colours a reader must tell apart also differ in lightness; blue with orange is safer than red with green.
- Options: two to four that really differ, along a line you can put a name to; an option keeps its name from one turn to the next.

`references/questions.md` covers when to ask before building, and how.
