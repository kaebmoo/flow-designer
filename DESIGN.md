---
name: Flow Designer
description: Air-traffic-obsidian control surface for the Atlas Control Plane — a dark cockpit for operators and customers.
colors:
  obsidian-deep: "oklch(0.19 0.03 254)"
  obsidian-raised: "oklch(0.22 0.03 254)"
  slate-elevated: "oklch(0.28 0.03 254)"
  hull-border: "oklch(0.32 0.03 254)"
  runway-cyan: "oklch(0.82 0.15 200)"
  warning-amber: "oklch(0.78 0.16 70)"
  signal-green: "oklch(0.75 0.17 160)"
  alert-red: "oklch(0.65 0.22 25)"
  telemetry-violet: "oklch(0.65 0.2 300)"
  ice-white: "oklch(0.97 0.01 240)"
  haze-grey: "oklch(0.72 0.03 240)"
  surface-raised: "#101a27"
  edge-label-border: "#33475a"
  edge-label-foreground: "#b6c7d7"
typography:
  display:
    fontFamily: "Inter Display, ui-sans-serif, system-ui, sans-serif"
    fontSize: "4.5rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Inter Display, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Inter Display, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter Display, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Inter Display, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "normal"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.625rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.1em"
  mono-chip:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.5625rem"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.12em"
  mono-strong:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.08em"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  2xl: "16px"
spacing:
  tight: "6px"
  node: "10px"
  sm: "8px"
  md: "16px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.runway-cyan}"
    textColor: "{colors.obsidian-deep}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-outline:
    backgroundColor: "{colors.obsidian-deep}"
    textColor: "{colors.ice-white}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.slate-elevated}"
    textColor: "{colors.ice-white}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ice-white}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-destructive:
    backgroundColor: "{colors.alert-red}"
    textColor: "{colors.ice-white}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  card:
    backgroundColor: "{colors.obsidian-raised}"
    textColor: "{colors.ice-white}"
    rounded: "{rounded.xl}"
    padding: "24px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.ice-white}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "36px"
  badge-default:
    backgroundColor: "{colors.runway-cyan}"
    textColor: "{colors.obsidian-deep}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "2px 10px"
---

# Design System: Flow Designer

## Overview

**Creative North Star: "Air Traffic Obsidian"**

Flow Designer is a control tower rendered as software. The whole surface sits in
a deep, cool obsidian — the darkness of a night-shift operations room where the
only things that glow are the ones that carry information. Into that dark, a
single **runway cyan** reads as the live, healthy, primary signal, and a warm
**warning amber** reads as attention. Nothing decorates; every luminous element
is telemetry. This is an Operate surface first: operators and customers come to
complete a task — read a run, edit a workflow, approve a gate — and the design's
job is to make state instantly legible and never to compete with it.

The system is calm at rest and expressive only under state. Surfaces are built
from tonal layering — obsidian floor, raised card, elevated slate — rather than
loud borders or heavy shadow, so depth is felt, not announced. Technical detail
(IDs, sequence cursors, byte counts, edge conditions) is set in **JetBrains
Mono**, giving the interface the honest, instrument-panel texture of a system
that shows you the real machine underneath. The one true accent colour is
rationed: its scarcity is what lets a single cyan ring mean "this node is
running" at a glance across a dense canvas.

Because Atlas is the only source of truth, the visual language is built to be
faithful and unembellished: it preserves real states and real limits instead of
smoothing them into a prettier story. Colour is never the sole carrier of
meaning — a state always pairs its hue with an icon and an accessible label, a
discipline the codebase already holds for colour-blind operators.

**Key Characteristics:**
- Dark cockpit throughout; light is information, not decoration.
- One rationed cyan primary + one amber attention accent; green/red/violet reserved for status.
- Tonal layering over shadow for depth; soft glow only on live state.
- Monospace for the machine, Inter Display for the human.
- State is never colour alone — always hue + icon + label.

## Colors

A cool blue-obsidian foundation (hue ~254) carries four saturated status
signals; the palette is defined in OKLCH so lightness steps stay perceptually
even across a very dark UI.

### Primary
- **Runway Cyan** (`oklch(0.82 0.15 200)`): The one true accent. Primary
  buttons, focus rings, selected/running state, active edges, chart series 1,
  and the `start` badge. It marks *live and primary* — and it is deliberately
  rare so that meaning holds.

### Secondary
- **Warning Amber** (`oklch(0.78 0.16 70)`): Attention and "AI decision"
  identity. The `manager` node tile, `waiting_for_human` state, and the
  `warning` role all share this hue. Warm against the cool floor, so it pulls
  the eye without alarming.

### Tertiary (status signals)
- **Signal Green** (`oklch(0.75 0.17 160)`): Success — succeeded runs, the
  `join` ("wait for branches") node.
- **Alert Red** (`oklch(0.65 0.22 25)`): Destructive/failed/interrupted and the
  `danger` role.
- **Telemetry Violet** (`oklch(0.65 0.2 300)`): Chart series 5 only; the extra
  categorical hue for data viz.

### Neutral
- **Obsidian Deep** (`oklch(0.19 0.03 254)`): The app floor / page background.
- **Obsidian Raised** (`oklch(0.22 0.03 254)`): Cards, popovers, sidebar,
  minimap — one step up from the floor.
- **Slate Elevated** (`oklch(0.28 0.03 254)`): Secondary buttons, muted fills,
  inputs, hover surfaces — the highest common surface.
- **Hull Border** (`oklch(0.32 0.03 254)`): The default divider/edge on every
  element (applied globally: `* { border-color: var(--color-border) }`).
- **Ice White** (`oklch(0.97 0.01 240)`): Primary foreground text.
- **Haze Grey** (`oklch(0.72 0.03 240)`): Muted/secondary text, descriptions,
  placeholders.

### Canvas-only surfaces
- **Edge label chip** (`--surface-raised #101a27`, border `#33475a`, text
  `#b6c7d7`): The raised chip that carries an edge's condition label on the
  workflow canvas. Intentionally hardcoded hex because it is the one place the
  React Flow renderer needs a fixed literal.

### Named Rules
**The One Signal Rule.** Runway cyan appears on ≤ ~10% of any screen. It is the
primary/live colour and nothing else may borrow it; its rarity is what makes a
single cyan ring legible on a crowded canvas.

**The Never-Colour-Alone Rule.** No state is communicated by hue alone. Running,
waiting, succeeded, failed each pair their colour with an icon and an accessible
label — the red ring is never the only issue signal.

## Typography

**Display / Body Font:** Inter Display (with `ui-sans-serif, system-ui,
sans-serif`), loaded at weights 400/500/600/700 with character variants
`cv02, cv03, cv04, cv11` enabled on `body`.
**Label / Mono Font:** JetBrains Mono (with `ui-monospace, monospace`), weights
400/500/600.

**Character:** Inter Display is the human voice — clean, tightly tracked at
larger sizes, quietly confident. JetBrains Mono is the machine voice — every
identifier, count, cursor, and edge condition is set in it, so "this is real
data from the system" is signalled typographically, not just verbally.

### Hierarchy
- **Display** (700, `text-7xl` / ~4.5rem, line-height 1): Reserved for hero
  numerals like the `404`. Not a routine page element.
- **Headline** (600, `text-xl` / 1.25rem, tracking-tight): Page and section
  titles, dialog titles.
- **Title** (600, ~0.95rem, leading-none, tracking-tight): Card titles and
  compact panel headers.
- **Body** (400, `text-sm` / 0.875rem, line-height ~1.5): Default UI text.
  Inputs render at `text-base` on mobile, `text-sm` from `md` up.
- **Label** (600, `text-xs` / 0.75rem): Badges, chips, small emphatic labels.
- **Mono** (500, uppercase, wide tracking) — a three-rung micro-scale for
  machine metadata, never body copy: `mono-chip` (9px) for badges/pills,
  `mono` (10px) for column labels and IDs, `mono-strong` (11px) for helper and
  emphasis lines. IDs, edge-condition labels, the `start` badge, counts.

### Named Rules
**The Machine-Voice Rule.** Anything that is literally a value from Atlas — an
ID, a sequence cursor, a byte count, an edge condition, a state token — is set
in JetBrains Mono. Prose about the system stays in Inter Display.

## Layout

App shell is a persistent sidebar (obsidian-raised) beside a scrollable content
region on the obsidian floor. Content pages are task tables and detail panes;
density is comfortable-compact — readable rows, not a spreadsheet crush. The
radius scale derives from a single `--radius: 0.5rem` root: `sm 4px`, `md 6px`,
`lg 8px`, `xl 12px`, `2xl 16px`. Card interiors use a generous `24px` (`p-6`)
pad; canvas nodes use a tight `10px` (`p-2.5`). Long/live lists (job logs, run
events) are bounded and incrementally rendered by rule — never an unbounded DOM
tree. The workflow editor is a full-bleed React Flow canvas with a resizable
inspector panel.

## Elevation & Depth

Depth is primarily **tonal layering**, not shadow: obsidian floor → raised card
→ elevated slate reads as three planes purely through lightness. Shadows are the
secondary, soft, ambient layer — `shadow-sm`/`shadow` on buttons and cards,
`shadow-lg` on canvas nodes so they float above the pane. The only *lit* depth
is state: a `pulse-glow` keyframe emits an expanding cyan ring for live/attention
moments, and focus rings are a 1px cyan halo.

### Named Rules
**The Layered-Not-Lifted Rule.** Reach for a lighter surface token before a
bigger shadow. Shadows stay soft and ambient; glow is reserved for live state,
never for ornament.

## Shapes

Rounded, instrument-panel geometry. Most controls are `rounded-md` (6px); cards
and canvas nodes are `rounded-xl` (12px); icon tiles are `rounded-lg` (8px).
Borders are the primary separators — 1px hull-border on nearly everything, and a
distinctive **2px border** on canvas nodes so the state-coloured ring is bold
enough to read at canvas zoom. The global `* { border-color }` reset means every
border already speaks the theme; you set width and radius, not colour.

## Components

### Buttons
- **Shape:** `rounded-md` (6px), height 36px default (`h-9`), `text-sm`
  medium-weight, `transition-colors`.
- **Primary:** runway-cyan fill, obsidian-deep text, subtle shadow; hover drops
  to 90% opacity.
- **Outline:** hull-border stroke on the obsidian floor; hover fills with amber
  accent + accent-foreground.
- **Secondary:** slate-elevated fill; hover 80% opacity.
- **Ghost:** transparent; hover fills amber accent.
- **Destructive:** alert-red fill, ice-white text.
- **Link:** cyan text, underline on hover.
- **Focus:** 1px cyan ring (`focus-visible:ring-1 ring-ring`), no outline.
- **Sizes:** `sm` h-8 / `text-xs`, `lg` h-10 / px-8, `icon` 36×36 square.

### Cards / Containers
- **Corner Style:** `rounded-xl` (12px).
- **Background:** obsidian-raised, ice-white text.
- **Shadow Strategy:** soft `shadow` (see Elevation) — layering does most of the work.
- **Border:** 1px hull-border.
- **Internal Padding:** 24px (`p-6`); header/content/footer share it.

### Inputs / Fields
- **Style:** transparent fill, 1px hull-border, `rounded-md`, height 36px, subtle shadow.
- **Focus:** 1px cyan ring, outline removed.
- **Placeholder:** haze-grey. **Disabled:** 50% opacity, not-allowed cursor.

### Badges / Chips
- **Default:** runway-cyan fill, obsidian-deep text, `rounded-md`, `text-xs`
  semibold. **Secondary:** slate-elevated. **Destructive:** alert-red.
  **Outline:** foreground text on transparent.
- **Mono status chips:** uppercase JetBrains Mono, tinted `/15` fill inside a
  `/40` border of the state colour (e.g. the `start` badge, edge labels).

### Workflow Canvas Node (signature component)
The defining custom surface. A `w-60`, `rounded-xl`, **2px-bordered** raised card
with a 36px icon tile, title, and derived hint. Four node kinds, each colour- and
icon-coded so kind is readable without reading:
- **AI Task** (`worker`, cyan/primary, `Cpu`)
- **AI Decision** (`manager`, amber/accent, `Sparkles`)
- **Wait for branches** (`join`, green/success, `Merge`)
- **Human decision** (`human_gate`, amber/warning, `ShieldCheck`)

The node's **border ring encodes live run state** straight from Atlas —
`running` cyan, `waiting_for_human` amber, `succeeded` green,
`failed`/`interrupted` red, `skipped` dimmed; an unknown Atlas state stays
neutral. Selection and local validation issues also drive the ring. Handles are
10px cyan dots ringed in the background colour; edges are cyan at 50% opacity,
full opacity when selected, with an animated dash `flow` keyframe.

### Navigation (sidebar)
Persistent obsidian-raised rail; items use ghost-style hover (highlight wash),
cyan for the active item. Icon + label pairing.

## Do's and Don'ts

### Do:
- **Do** reference semantic tokens, never literals — `bg-card`, `text-primary`,
  `border-border`. The one sanctioned exception is the canvas edge-label chip
  (`--surface-raised` and friends), which the renderer needs as fixed hex.
- **Do** pair every state colour with an icon and an accessible label
  (`aria-live` for streaming status), and target **WCAG 2.1 AA** contrast.
- **Do** set real Atlas values (IDs, cursors, counts, conditions) in JetBrains
  Mono; keep prose in Inter Display.
- **Do** build depth by stepping surface tokens (obsidian → raised → slate)
  before adding shadow.
- **Do** keep runway cyan rare — it means primary/live.

### Don't:
- **Don't** introduce a new hue for a status; the five signals (cyan/amber/green/
  red/violet) plus neutrals are the whole vocabulary.
- **Don't** use colour as the only signal for a state, error, or node kind.
- **Don't** hardcode `bg-[#...]`, `bg-black`, or `text-white`; the global border
  reset and token layer already carry the theme.
- **Don't** render an unbounded live/log list into one DOM tree — bound and
  incrementally render.
- **Don't** spend cyan on decoration, or reach for a heavier shadow where a
  lighter surface token conveys the same lift.
