---
name: canvas-artifact
description: How to design polished Mandate HTML canvases. Load before creating or substantially redesigning a canvas.
scope: [manager, worker]
---

# Mandate Canvas Artifacts

Canvas is the user's visual workspace for plans, reports, dashboards, and
decision support. Design it like a modern product page the user will
actually look at — a shipped artifact, not a transcript dump and not a memo.

## Choose The Artifact Type

Before writing HTML, decide what the canvas is for:

- **Status dashboard**: current state, progress, blockers, next checks.
- **Plan**: proposed path, phases, risks, validation steps.
- **Report**: conclusion, evidence, findings, recommendations.
- **Comparison**: options, tradeoffs, decision criteria, chosen direction.
- **Runbook**: ordered procedure, commands, preconditions, rollback.

Match the layout to that purpose. Lean into visual structure over walls of
prose.

## Information Architecture

Put the user's next decision first:

1. Lead with the conclusion or current state.
2. Show the 3-6 facts that matter most.
3. Put evidence, commands, diffs, risks, and long notes below.
4. Keep related details together; avoid scattering the same fact across cards.
5. If content is long, use sections or `<details><summary>` so the main path
   stays scannable.

Every card or section earns its place by carrying a distinct idea, metric,
option, or piece of evidence. Density is fine — emptiness is not.

## Quality Bar

Canvas is a shipped product surface. The reference is high-end SaaS product
UI (Linear, Vercel, Stripe quality), not an admin dashboard, not a status
report, not a markdown render. If it would feel out of place in a polished
web app, redesign before publishing.

Visual is the default; prose is the fallback when no visual form fits the
fact. Conclusion first; visual weight tracks hierarchy. Code blocks use
`<pre><code>` with soft wrap or horizontal overflow. Design for both desktop
and narrow widths.

A canvas fails two opposite ways: the flat gray admin panel, and loud AI
slop (default indigo accent, purple→blue gradient hero, emoji icons, six
tinted cards). The target is neither — restraint + intentional type + one
bold move. **Before designing or substantially redesigning, read
`references/anti-ai-slop.md`** (via `read_skill_reference`); it has the
concrete don'ts and the dark-canvas palette/elevation guidance.

## Interaction

Use interactive HTML and inline JS whenever it speeds the user up. Every
control must do something visible when used; no fake controls, dead
navigation, or filters that don't change visible content.

## You Own The Whole Design

The canvas is a self-contained page rendered in its own sandboxed iframe —
it is NOT chrome that must match the app shell. Design the entire surface
yourself: background, color palette, typography, spacing, depth.

- **Set your own background.** The canvas sits on a dark app surface, so
  design a cohesive dark page: give `<body>` (or your root wrapper) a real
  dark background you choose — e.g. `bg-slate-950`, `bg-zinc-950`, or a dark
  gradient. Don't leave it to inherit.
- **Pick a real palette and commit.** Use the full Tailwind color vocabulary
  directly: `bg-gradient-to-br from-indigo-600 to-fuchsia-600`, colored rings
  (`ring-1 ring-emerald-400/30`), tinted surfaces (`bg-sky-500/10`), accent
  text (`text-emerald-300`), shadows, blur. A high-end product page uses
  color and depth decisively — lean in.
- **Do NOT use Mandate theme tokens** (`bg-card`, `bg-background`,
  `border-border`, `text-muted-foreground`, `bg-muted`). They render as a
  flat, near-monochrome gray and are the reason canvases look like a dull
  admin panel. Choose concrete colors instead.
- Tailwind is available automatically (no setup needed). `<style>` blocks are
  fine — scoped to the iframe. Use them for hover states, transitions, tab
  toggles, custom keyframes.
- **Namespace semantic CSS classes.** Prefix classes and selectors that you
  define yourself with `canvas-` (for example, `canvas-verdict-card` and
  `canvas-patched-result`). Keep Tailwind utility classes such as `fixed`,
  `grid`, `flex`, `hidden`, and `text-*` for their intended utility behavior;
  do not reuse them as names for custom components or status variants. This
  prevents the automatically loaded Tailwind stylesheet from changing the
  layout of a semantic element.
- Inline `<script>` for canvas-local interaction (tab switching, copy
  buttons, chart rendering, toggles) is fine. Keep it self-contained: no
  network APIs, no auth, no parent-page globals.
- Feature canvases auto-grow in the Overview tab. Do not create a full-page
  scrolling shell inside the canvas.
- Avoid viewport-height traps in embedded canvases: do not use `min-h-screen`,
  `h-screen`, `100vh`, or `100dvh` for the main canvas shell.

## Publish Checklist

Before every `canvas_publish`, verify:

- The canvas answers what the user needs to decide or review next.
- It contains real content, not placeholders or vague labels.
- It sets its own dark background and reads as a cohesive, designed page —
  not flat gray boxes on an undefined surface.
- It remains usable at narrow widths.
- There is no internal page scrollbar for a feature Overview canvas.
- Text is not clipped, overlapping, or hidden by fixed elements.
- Every interactive control has visible behavior or is removed.
