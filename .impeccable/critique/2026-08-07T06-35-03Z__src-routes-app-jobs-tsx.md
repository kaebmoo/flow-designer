---
target: jobs (src/routes/_app/jobs.tsx)
total_score: 35
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-08-07T06-35-03Z
slug: src-routes-app-jobs-tsx
---
Method: dual-agent (A: design-review · B: detector+grep). Browser overlay skipped — no browser-automation tool this session.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | States explicit, but running jobs never poll — list is a silent snapshot; drawer content not announced |
| 2 | Match System / Real World | 4 | Atlas's own state enum + names the real side effect ("marks cancel_requested") |
| 3 | User Control & Freedom | 4 | Escape closes pane, filters clear, state in URL (shareable/back), cancel confirmable |
| 4 | Consistency & Standards | 3 | Cyan job ID looks like a link but isn't; toggle chips lack aria-pressed |
| 5 | Error Prevention | 4 | Cancel confirm + disabled-with-reason (`:199-215`) is exemplary |
| 6 | Recognition over Recall | 3 | Active workflow/group subtitles shown, but crowded filter bar leans on scanning many similar chips |
| 7 | Flexibility & Efficiency | 3 | URL state + grouping help, but no manual refresh, no shortcuts, no bulk action |
| 8 | Aesthetic & Minimalist | 3 | PageHeader meta crams workflow select + group toggle + 7 state chips + window options into one wrapping row |
| 9 | Error Recovery | 4 | AtlasErrorState distinguishes forbidden/not-found/outage + retry; cancel error inline with role=alert |
| 10 | Help & Documentation | 4 | Inline notes on client-side state filtering + workflow-matching limits (`:713-733`) — best-in-class |
| **Total** | | **35/40** | **Good** (high) — the strongest surface reviewed |

## Design Specificity Verdict
Unmistakably "Air Traffic Obsidian": every Atlas value in JetBrains Mono (`:460,484,489,495`), tonal `bg-card`/`bg-background/50` layering, honesty copy (`:713-733`). Lapses are specific: cyan over-spent (every job ID is `text-primary` `:460`) and Never-Colour-Alone broken by filter chips (active state = cyan alone, no aria-pressed). High specificity, real cockpit texture, but token *rules* applied more loosely than the detail pane's careful focus work.

**Deterministic scan:** detector ×2 font-size (9px @77, 11px @372). Token-clean. a11y hooks: 9 aria- (drawer done right), but chips have 0 aria-pressed. **Non-modal drawer verified correct** (`:268-293`): tabIndex={-1}+aria-label, focus in on open, opener restored on cleanup, Esc closes, no aria-modal/no Tab-trap. Output bounded (`max-h-48`/`max-h-64`, truncate) but not virtualized.

## Priority Issues
**[P1] Active filter state is colour-alone and invisible to screen readers.** State chips, group toggle, window chips signal "selected" via cyan only, no aria-pressed, no non-colour marker (`:541-558, 560-584, 589-602`). Breaks Never-Colour-Alone + WCAG AA. Fix: add `aria-pressed` to each toggle/chip + a non-colour affordance (check glyph / ring+weight / leading dot). → **harden**

**[P1] No selected-row indicator while the drawer is open.** `toggleSelectedJob` drives URL + opens pane, but the originating row gets no selected styling (`:698-704`; DataTable has no selected concept). On a dense list the operator loses the anchor. Fix: pass selectedRowKey/isSelected to DataTable, mark active row (cyan left-border or bg-primary/5) + aria-current. → **clarify**

**[P2] Job ID reads as a link but isn't, over-spends cyan.** Every job ID is `text-primary` (`:460`) yet not a link; real links use the same colour (`:119`). Affordance mismatch + One-Signal violation. Fix: neutral mono id; reserve cyan for live/primary. → **quieter**

**[P2] Running jobs never update; silent snapshot.** Neither list (`:398`) nor detail (`:273`) polls; no manual refresh. A `running`/`cancel_requested` job stays frozen till reload. Fix: `refetchInterval` while any visible job is non-terminal (+ open non-terminal detail), plus "as of <time>" + manual refresh. → **harden**

**[P3] Overloaded filter bar.** Workflow select + group toggle + 7 state chips + N window chips in one wrapping row (`:512-603`) = three >4-option decision points stacked. Fix: segment into labelled groups (segmented control for state), collapse window into a compact select. → **distill**

## Cognitive Load: MODERATE–HIGH at entry
Three >4-option decision points: 7 state chips (`:571-584`), window options (`:589-602`), workflow dropdown up to 100 (`:31`). Table up to 8 columns.

## Persona Red Flags
- **Alex:** no manual refresh/polling, no shortcuts, no bulk cancel/select — reloads constantly to watch a queue drain.
- **Sam:** drawer focus + Esc + focus-return **done right** (real strength). Gaps: chips no aria-pressed + colour-only (P1); drawer Loading→loaded transition NOT announced (no aria-live around `:321-384`); when SSE lands here it'll need aria-live + a bounded/virtualized renderer.
- **Riley:** 0 jobs handled; refresh safe (query-driven); huge output partially covered — height bounded (`max-h-64`) but `assistantText` is one un-virtualized `<pre>` (fine for one persisted blob, NOT the bounded/virtualized pattern PRODUCT mandates for the live path).

## Minor
"Assistant output" is persisted, not live (`:370-382`) — height-bounded, not virtualized; StatusPill correctly pairs hue+dot+label (contrast with the chips that don't); non-modal Esc only fires when focus is in the aside; switching jobs re-runs focus effect (briefly bounces); `Field` values `break-all` hard-breaks model names.

## Questions
1. If this is Operate, why does nothing move — should a "running" list be live by construction, and if not, does the frozen pill lie? 2. Meticulous drawer focus, yet chips ship without aria-pressed — is a11y applied per-component instead of per-surface? 3. When SSE lands, does `<pre max-h-64>` become the unbounded DOM the system forbids — build the virtualized renderer now?
