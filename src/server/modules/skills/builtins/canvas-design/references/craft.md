# Designing well, at length

SKILL.md has the short rules. This file has the reasons and the detail. Read it when the user disagrees with a design decision, or for the part a piece of work needs: choosing a look, offering options, a landing page, a phone prototype, redrawing an interface that exists. The rules about what goes on an artboard are at the end.

## Where the look comes from

### From the user

A design with no look given, no reference and no design system is not yours to style alone. Ask, or draw two to four rough artboards that take really different directions and let the user point at one. Choosing for them, unasked, is how a design ends up looking like every other generated one. A subject, a brand or a picture they gave you is already an answer: use it. When nobody can be asked, take one direction you can put a name to and say which you took, instead of ending on a question. A decision that has been made stays made.

### From the product

A finished-looking design starts from what exists: the repository, the brand's files, screenshots of the product as it is, a design system. A worker designing for its own feature has the repository at hand: read its actual components, styles and tokens first, and ask the user for what you cannot find. Drawing a whole product out of nothing is the last thing to try, and it shows. Tell the user early what you assumed and why, and show them a first version the moment there is anything for them to respond to.

Where an icon, a picture or a component is missing, draw a plain placeholder. In a finished-looking design a marked gap is better than a poor imitation.

### When nothing governs

With no brand and no design system, decide on a direction before building, and make it a definite one.

- What is this for, and who uses it?
- What is its character? Push it to an extreme and name it in a word or two: severe, lavish, playful, technical, handmade, whatever fits. The name is a compass, not a costume.
- What is the one thing a person will remember about it?

A quiet design and a loud one can both be right. What makes either work is that every part follows the same decision. Then settle a small system and keep to it:

- **Type.** One to three families. Give each a system face of similar proportions to fall back on while the font loads. A webfont reaches an artboard in two ways only: from Google Fonts, by one `<link>` to `fonts.googleapis.com/css2?family=…&display=swap` placed first in the page, or embedded as a data: URI in @font-face. No other font host loads. Prefer a face with some character for headings over the ones every interface already uses, and set a calmer one for text beside it.
- **Ground.** Decide whether the piece is warm, cool or neutral, and tint its whites and blacks that way, only just: whites stay under 0.02 saturation.
- **Accents.** None, one or two. Write them in oklch with the same chroma and lightness and different hues, so they sit together. Start from the brand's colours when there are any; if they are too few, derive neighbours from them rather than adding strangers.
- **Colour weight.** A few dominant colours and a sharp accent read more clearly than many colours used evenly.
- **Composition.** Consider an arrangement that is not the expected grid: something off-centre, something overlapping, a strong diagonal, a lot of empty space or a deliberate crowd.
- **Surface.** A flat fill is one choice among several: texture, pattern, layered transparency, a hard shadow or a drawn border can give a piece depth when its character calls for it.
- **Motion.** Where an artboard animates (CSS in the page), spend it on one moment that matters rather than on many small ones.

Do not arrive at the same choices every time: vary light and dark, the faces, the character. And build to the direction you chose: an elaborate one needs elaborate execution, a spare one needs exact spacing and detail.

## Options

Several artboards side by side are how a user chooses, so plan what they will be choosing between.

- When a question of direction is open (the overall look, the layout of the opening, the type pairing, light or dark, how dense), settle it before building the whole thing. Offer two to four candidates that differ along a line you can name, such as "calm, with room to read" against "everything on one screen". Five shades of one idea are not a choice. A rough artboard is enough to choose a direction from; finish comes later.
- Say what each option is for and what it costs, in your reply and not on the artboard. If only your favourite gets an argument, the vote is fixed.
- An option keeps its name. An artboard the user has come to know as "B", or as "the calm one", is never renumbered or renamed in a later turn.
- Once a direction is chosen, a user who asks for variations gets at least three, varying more than one thing: some that follow the product's existing patterns closely, some that try a new layout, interaction or treatment of the brand's shapes, textures and type. Aim for pieces the user can combine, not for one perfect answer.
- Early on, sketch: three to five distinct approaches to an idea, plain shapes, placeholder words, almost no colour. Structure and flow first.

## Drawing the screens

**Layout.** Put siblings that form a group (buttons, chips, icons, cards, navigation items, toolbars) in a flex or grid container and space them with `gap`. Do not leave them inline to be spaced by whitespace in the source, and do not put a margin on each. Keep inline flow for sentences, where an `<a>`, a `<strong>` or an `<em>` may sit among the words. Reach for current CSS, `text-wrap: pretty` and grid included.

**Sizes.** On a phone-screen artboard, nothing meant to be tapped is smaller than 44px. Size text for the distance it will be read from.

**Accessible as drawn.** A mockup nobody will click still uses the elements a browser understands: a `<button>` for a button, an `<a href>` for a link, an `<input>` with its `<label>`. A `div` with a click handler looks the same and is skipped by the Tab key and unannounced by a screen reader. An icon-only button has an `aria-label`. Text needs 4.5:1 against its background, or 3:1 once it is 24px or larger; the usual failures are grey captions and white text on a coloured fill, and the cure for both is darker. Colours that must be told apart differ in lightness as well as hue; blue against orange is safer than red against green.

**Phone screens.** Draw no status bar with a clock and a battery, and no on-screen keyboard: the phone's own system puts its bar and keyboard over your layout, and painted ones look doubled. Leave the space empty, including inside a phone frame on a desktop artboard.

## Kinds of work

### Landing and marketing pages

A landing page has a known shape. It opens by saying what is offered in one sentence, with one thing to do about it. It shows why a visitor should believe it: quotes, customers, numbers, taken from the user's own material or drawn as clearly marked placeholders. Its sections answer the doubts a visitor really has, instead of listing features. It has one main action, which may recur down the page; it does not have three competing ones.

On such a page the words are the product. Take them from what you were told: what the product is, who buys it, how the company talks. No placeholder Latin, no greeting that could open any site, no sentence that would fit any business. When you do not have a fact the page needs, such as what it costs or when it opens, leave a visible marker such as [YOUR PRICE] that the user will replace, and invent nothing. Write it for a phone's width as well, as you go: no headline that breaks badly there, no grid squeezed thin, no type too small to read.

### Redrawing an interface that exists

When the user wants an existing interface recreated and you can read its source (a checkout of the repository, files they pasted, a design system they attached), build from that source and not from what you remember the product looking like. Read its components and its styles. Use the assets the page really loads (icons, fonts, images, stylesheets), not component source that exists only for the bundler. Copy its numbers as they stand (padding, corner radius, font size, line height). Do not round them to a 4px or 8px grid or to a framework's defaults. Where source can be read, a screenshot is a rough guide and nothing more. Where it cannot, say so and stop; do not draw from memory. Whether to recreate it at all is the last rule below.

## Content rules

These are about what is on the artboards.

- **Nothing to fill space.** No placeholder paragraphs, no sections added for bulk, no numbers, icons or statistics that tell the reader nothing. If part of a design looks empty, that is a problem of layout, to be solved by composition and not by inventing content. When in doubt, leave it out.
- **Ask before adding.** If you think more sections, pages or copy would make the design better, propose them. They know who it is for and what it has to do better than you can.
- **A small change stays small.** Asked to change some words, a colour or one element, change that and leave everything else exactly as it was: layout, spacing, type, sizes, positions, colours, content. Asked for a redesign or a new direction, make the large change. If you believe a small request needs a wider one, do what was asked and suggest the rest.
- **Match what is there.** When you add to an existing interface or document, learn how it speaks first and speak the same way: its wording, its palette, its states on hover and press, its motion, its shadows and cards, its density.
- **No generic looks.** Gradient washes behind everything, rounded boxes with a coloured stripe down one side, and the handful of typefaces every generated page reaches for (Inter, Roboto, Arial, Fraunces) mark a design as made without thought. So do emoji: put one on an artboard, in its copy as much as in its decoration, only when the brand or the design system uses them.
- **Other companies' designs.** Do not reproduce a company's distinctive interface, its command set or its branded elements. The exception is a user who says they work at that company. Find out what they want to build and help them make something of their own. Mandate has no way to know where the user works, so this rests on what they tell you: ask when it is unclear.
