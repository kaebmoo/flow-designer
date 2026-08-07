---
target: runs index (src/routes/_app/runs.index.tsx)
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
timestamp: 2026-08-07T06-52-14Z
slug: src-routes-app-runs-index-tsx
---
Method: dual-agent (A: design-review · B: detector+grep). Browser overlay skipped — no browser-automation tool this session.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | loading/error/window-notice/URL filters present; no per-state counts, running runs don't refresh |
| 2 | Match System / Real World | 2 | raw tokens (waiting_for_human, recovery_required) honest but jargon for customers |
| 3 | User Control & Freedom | 3 | shareable URL filters, "all" reset, workflow Clear; no clear-all or combined filtering |
| 4 | Consistency & Standards | 3 | state chips + limit chips visually identical despite different meaning |
| 5 | Error Prevention | 2 | client-side state filter renders an empty table that reads as "no failures exist" |
| 6 | Recognition over Recall | 2 | limit chips (25/100/500) unlabeled numbers; state column buried far right |
| 7 | Flexibility & Efficiency | 2 | no sort, no ID search, no bulk, no per-row navigation |
| 8 | Aesthetic & Minimalist | 3 | calm/mono-disciplined; two full UTC timestamp columns are heavy |
| 9 | Error Recovery | 4 | AtlasErrorState (forbidden/not-found/unauthorized/retryable) + redirect-loop guard |
| 10 | Help & Documentation | 3 | strong inline copy (window notice, filter caveat, workflow banner) |
| **Total** | | **27/40** | **Acceptable** — truth-telling posture, but the triage scan it exists for is hard |

## Design Specificity Verdict
Genuinely design-specific: fluent Air Traffic Obsidian (mono on every machine value, rationed-cyan selection, tonal surfaces) and a truth-telling posture (WindowNotice, client-filter caveat, "no state filter on this endpoint" comment) enacting Principle 4. Drifts from the state-legibility promise: state at the far-right edge, several states collapse to one hue, pill has a dot but no icon — "hue+icon+label" is really "hue+label".

**Deterministic scan:** detector clean (0). Token-clean. a11y 1 aria- (a decorative separator); state carried by text label not colour-alone (StatusPill tone+label), BUT filter selection is colour-alone. `<th>` scope not in this file (DataTable). 4× text-[10px].

## Priority Issues
**[P0] Filter selection is invisible to assistive tech.** Chip buttons (:66-105) convey active state only via cyan; no aria-pressed/aria-current, no role=group/aria-label. Sam can't perceive which state/limit filter is active — WCAG 4.1.2/1.4.1, the exact bar the product sets. Fix: aria-pressed on each; wrap clusters in role=group with aria-label ("Filter by state"/"Rows to load"). → **harden**

**[P1] Run state is hard to scan: far-right + hue collisions + no icon.** State is the last right-aligned column (:194-199); StatusPill has a dot but no per-state icon; tone table collapses failed+recovery_required→red, paused+waiting_for_human→amber, queued+cancelled→grey (atlas-mappers.ts:270-279). Alex can't distinguish the most urgent state (recovery_required) from failed by colour, and must scan to the far edge. Fix: move State to column 1-2; add a distinct lucide icon per state in the pill. → **colorize** / **layout**

**[P1] 12 undifferentiated pills in one row.** "all" + 8 state chips + 3 limit chips share identical rounded-full mono styling, separated only by a hairline divider (:65-106,91). A customer can't tell a filter from a page-size control. Fix: inline group labels ("State"/"Show"); make the limit cluster a segmented control. → **distill**

**[P2] Rows aren't clickable; tiny link-only targets.** DataTable ships onRowClick support (page.tsx:103-114) but runs.index (:136) never passes it; navigation is only the text-xs mono ID link (:149-156). Fix: pass onRowClick to navigate; keep the ID link but make the whole row the target. → **layout**

**[P2] Client-filter empty state reads as "no failures exist".** State filter runs in-browser over one window (:55-57); an empty result shows a terse cell (:140-142) with the caveat placed *after* the table (:208-213). False reassurance on the highest-stakes query. Fix: move the caveat into/above the empty state + offer inline "Load more"/jump-to-500. → **clarify**

## Cognitive Load: HIGH at the chip row
>4-option decision points: state filter is 8 options + "all" + 3 limit = 12 controls in one undifferentiated wrap row (:65-106).

## Persona Red Flags
- **Alex:** state column rightmost; failed≡recovery_required (red) and waiting_for_human≡paused (amber), no icons; no count-by-state; the failed filter can render a misleadingly empty table.
- **Sam:** filter chips lack aria-pressed/group labels (P0); run state itself passes colour-alone (dot+label) but selection doesn't; `<th>` missing scope (page.tsx:77); deleted-workflow reason via title only (:172); only ID/name links focusable, not the row.
- **Riley:** 0 runs → flat one-liner, no next step; huge list bounded (good); all-failed → wall of identical red pills, no "N failed of M" summary.

## Minor
`<th>` missing scope; only running pulses — waiting_for_human (a blocked run needing action) has no motion despite amber="attention"; two adjacent full UTC columns, no relative time; deleted-workflow name nearly identical to a live link (only hover distinguishes).

## Questions
1. If recovery_required is the state an operator most needs to filter for, why does it share red with failed, carry no icon, and sit rightmost? 2. Is silently filtering a 25-row window ever safe for a customer asking "do I have failures?" — should the state filter be disabled/annotated until Atlas can answer it? 3. Running runs never update without a manual refetch — faithful to Atlas, or presenting stale state as truth on the one surface where liveness matters?
