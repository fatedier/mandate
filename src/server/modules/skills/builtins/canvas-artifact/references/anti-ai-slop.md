# Canvas Craft — Avoiding AI Slop

A canvas fails in two opposite directions. Both read as "made by an AI":

1. **The gray admin panel** — every section the same flat card, monochrome,
   walls of prose. Lifeless.
2. **The AI slop** — default indigo accent, a purple→blue "trust gradient"
   hero, six tinted cards, emoji icons, glow everywhere. Loud but generic.

The target is neither. It's **restraint + intentional typography + one bold
move + real hierarchy**. ~80% proven patterns, ~20% one distinctive choice.
Screenshot test: could someone tell *which* artifact this is from a
screenshot? If it could be any AI dashboard, it's a template, not a design.

## Must avoid (these are the textbook AI tells)

- **Default indigo/violet accent.** Never `#6366f1`, `#4f46e5`, `#4338ca`,
  `#8b5cf6`, `#7c3aed`, `#a855f7`. Indigo is *the* AI tell. Choose a
  deliberate accent that fits the content (a teal, amber, rose, lime, sky —
  pick one and own it).
- **Two-stop "trust gradient" hero.** No purple→blue, blue→cyan, indigo→pink
  gradient banners. A flat surface + confident type beats this every time.
  If you reach for a gradient hero, that's the reflex to resist.
- **Emoji as icons.** No ✨🚀🎯⚡🔥💡 in headings, badges, list bullets, or
  "icon" slots. Use inline monoline SVG (1.5–1.8px stroke, `currentColor`),
  or just clean type + a colored dot.
- **Rounded card + colored left-border stripe.** This combo screams "AI
  dashboard." Drop one of the two.
- **Invented metrics.** No "10× faster", "99.9% uptime", fake counts. Use real
  numbers from the actual work, or none.
- **Filler / placeholder copy.** Real content only. An empty section is a
  composition problem, not a text problem — cut it.

## Restraint (the part that's easy to overshoot)

- **One accent, used sparingly.** Pick a single accent color. Show it in
  **at most ~2 prominent places** per screen. Six tinted cards in a row
  (emerald + sky + violet + amber…) is mechanical — that's the slop direction.
  Neutrals carry the page; the accent points at the one thing that matters.
- **Semantic color only encodes state.** success / warning / danger earn their
  color by meaning, not decoration. A "Classification" card isn't green just
  to be colorful.
- **Small palette.** Keep raw hex values few; lean on a handful of neutral
  surface steps + one accent. Many one-off colors = lost control.
- **No decorative geometry.** No blob/wave SVG backgrounds, no glow that
  encodes nothing. Depth should come from real elevation, not fog.
- **Vary weight to match hierarchy, not for variety.** Sections at different
  importance look different (size, surface, spacing). Equal-weight everything
  is the gray-panel failure; random-weight everything is noise.

## Dark canvas (Mandate default)

The canvas sits on a dark app surface — design a cohesive dark page you own.

- **Real elevation, not gray-on-gray.** Pick a near-black base
  (`#0b0d10`-ish), and make raised surfaces *clearly* lighter than the base
  (not 8/255 lighter). A hairline border + a restrained shadow reads as a
  surface; a card the same color as the page reads as nothing.
- **Type does the heavy lifting.** A clear scale (one big confident title,
  a calm body size, a small uppercase label) creates more "designed" feeling
  than any amount of color. Tighten letter-spacing on large display text.
- **Generous, uneven spacing.** Whitespace is the separator. Alternate tight
  and breathing sections for rhythm — perfectly even spacing reads as default.

## Adding soul (the 20%)

Pick *one*, not all:

- One bold visual move — an oversized title, an unexpected proportion, a
  single decisive accent moment.
- Specific microcopy — "Start tracking" not "Get started"; name the real
  thing, not a generic label.
- One subtle micro-interaction — a hover reveal, a count, a tab — if the
  content has depth that benefits.

Stop there. Soul is one intentional choice, not five effects.
