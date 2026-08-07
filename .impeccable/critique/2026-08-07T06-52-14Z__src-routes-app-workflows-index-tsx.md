---
target: workflows index (src/routes/_app/workflows.index.tsx)
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-08-07T06-52-14Z
slug: src-routes-app-workflows-index-tsx
---
Method: dual-agent (A: design-review · B: detector+grep). Browser overlay skipped — no browser-automation tool this session.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | loading/error/pending/window-notice present; pending is ambiguous (all 5 create buttons) |
| 2 | Match System / Real World | 3 | clear nouns, but "Window" jargon + vocab split (steps/paths vs nodes/edges) |
| 3 | User Control & Freedom | 2 | "New workflow" creates immediately, no undo/cancel/rename/delete from list |
| 4 | Consistency & Standards | 2 | starter cards "N steps · M paths" (:183) vs real cards "N nodes · M edges" (:230-231), same concept |
| 5 | Error Prevention | 2 | one click spawns a persisted "Untitled workflow"; nothing guards accidental/duplicate creation |
| 6 | Recognition over Recall | 3 | cards surface name/desc/counts/status/version; window pills visible |
| 7 | Flexibility & Efficiency | 2 | no search/sort/filter, no shortcut; only 25/100/500 window |
| 8 | Aesthetic & Minimalist | 3 | clean, but starters consume prime real estate on every visit; "Ready to use" filler |
| 9 | Error Recovery | 3 | AtlasErrorState + retry + role=alert create error (:148) survives the empty state |
| 10 | Help & Documentation | 2 | bare empty message, no inline help or docs link |
| **Total** | | **25/40** | **Acceptable** — on-brand, but onboarding sits above operating |

## Design Specificity Verdict
Genuinely on-brand: tonal tiles, cyan rationed to primary button + selected pill, mono on machine values, StatusPill hue+dot+label, WindowNotice refuses to fabricate a total. Weakness is IA, not fidelity: an Operate surface leads with onboarding (starter examples) permanently above the operator's own workflows.

**Deterministic scan:** detector ×1 font-size (9px @ 106). Token-clean. a11y 2 aria-/1 role=; the real workflow list has **no heading/landmark** (only the starter `<section>` is aria-labelledby). Bounded by limit + WindowNotice. 6× text-[9-10px].

## Priority Issues
**[P1] IA inversion: onboarding above operating.** Starter workflows render unconditionally above the real list (:152-198). Every return visit buries the primary task (find/open an existing workflow) under four marketing-shaped cards. Fix: show starters prominently only when the list is empty; otherwise collapse to a single "Start from a template" affordance or move below. → **layout** / **distill**

**[P1] Selected window state is not programmatic.** The 25/100/500 pills (:127-140) convey active state only via colour, no aria-pressed/aria-current, no group label. Sam can't tell which window is active. Fix: aria-pressed (or role=radiogroup + aria-checked) + a "Window size" group label. → **harden**

**[P2] Empty state is a bare dead-end.** "Atlas has no workflow definitions yet." (:206-209) — no icon, no CTA, no link to the starters/New workflow right above it. Fix: EmptyHint pattern with icon + "Pick a starter above or create a blank workflow." → **onboard**

**[P2] Vocabulary inconsistency for the same concept.** Starters "steps · paths" (:183) vs real cards "nodes · edges" (:230-231). Fix: one register everywhere. → **clarify**

**[P2] Ambiguous pending: all five create buttons say "Creating…".** create.isPending disables + relabels the New workflow button AND all four example buttons (:118,189-193). Fix: spinner only on the invoked control (track pending example id). → **polish**

## Cognitive Load: MODERATE (HIGH at scale)
First-run create is a 5-way choice (4 examples + blank, >4 flag). Two distinct card systems on one page. At 500 cards with no filter → HIGH.

## Persona Red Flags
- **Jordan:** "New workflow" discoverable, but blank path creates "Untitled workflow" with one empty node and drops into the editor with no guidance; empty-list message doesn't connect to the tools above; first decision is a 5-way fork with no recommended default.
- **Sam:** window pills lack aria-pressed (:127-140); the real list has no heading/landmark (heading-nav skips the operator's own workflows); Import-pack disabled reason via title (:96-100); truncated card titles have no title attr (clipped name unrecoverable).
- **Riley:** many → starters push the list below fold; no search/sort/filter; 500 = unbroken wall; repeated blank creates yield indistinguishable "Untitled workflow" cards.

## Minor
"Ready to use" (:165) decorative filler; subtitle restates title; two grids use different column counts (4 vs 3), slightly misaligning the card systems.

## Questions
1. With no total/cursor/search, is a card grid honest — or does an unsortable/unsearchable 500-item wall mislead about completeness? 2. Should starters live on the index at all, or in the editor's new-workflow flow — freeing this surface to be purely Operate? 3. What stops the list filling with abandoned "Untitled workflow" drafts, and whose job is it to surface/clean them?
