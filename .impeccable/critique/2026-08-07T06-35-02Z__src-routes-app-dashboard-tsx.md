---
target: dashboard (src/routes/_app/dashboard.tsx)
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
timestamp: 2026-08-07T06-35-02Z
slug: src-routes-app-dashboard-tsx
---
Method: dual-agent (A: design-review · B: detector+grep). Browser overlay skipped — no browser-automation tool this session.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Skeletons + "aggregates as of" good, but two loading treatments, no auto-refresh/staleness cue |
| 2 | Match System / Real World | 3 | "Mission Control"/"Fleet" on-brand, but "your worker fleet" is operator jargon for a customer |
| 3 | User Control & Freedom | 3 | Per-panel retry solid; no manual refresh, no jump to failed/active |
| 4 | Consistency & Standards | 3 | MetricSkeleton ("—") vs PanelState ("Loading…") inconsistent loading idioms |
| 5 | Error Prevention | 3 | Isolated per-panel failure prevents total blank; little else to guard |
| 6 | Recognition over Recall | 3 | State pills labelled, but no legend for tone meanings |
| 7 | Flexibility & Efficiency | 2 | No filters, no triage shortcuts, no density control |
| 8 | Aesthetic & Minimalist | 3 | Calm and on-brand; borders on too flat |
| 9 | Error Recovery | 4 | AtlasErrorState maps each failure kind to distinct copy + conditional retry (`states.tsx:129-173`) |
| 10 | Help & Documentation | 2 | Only inline help is the success-rate note; no legend, no first-timer framing |
| **Total** | | **29/40** | **Good** (low end) — an overview that under-uses its own data |

## Design Specificity Verdict
Authored for Atlas, unusually so on honesty mechanics: per-panel query isolation so a degraded Atlas still renders what answers (`:67-89`), a stated refusal to fabricate a success-rate the `read` role can't get (`:186-191`), headline counts are Atlas COUNT(*) never derived from previews (`:125-130`). BUT it under-uses its design system *as an overview*: `workersByStatus`/`runsByState`/`jobsByState` are computed (`atlas-mappers.ts:900-904`), `chart-1..5` tokens exist, recharts is installed — yet the dashboard renders **zero charts** and shows four scalar tiles. For a scan-and-decide surface, that's the central miss.

**Deterministic scan:** detector ×2 font-size (11px @ 226, 267). Token-clean. **No charts present** (B confirms: 0 recharts/chart-token usage). a11y hooks 0 in-file (StatusPill in page.tsx carries tone+dot+label — "never colour alone" holds for pills, but the metric tiles are colour-only). Responsive good (md/lg grid-cols, flex-wrap header).

## Priority Issues
**[P1] The overview shows no distributions; it discards data it already has.** Only four scalar tiles (`:137-177`); `workersByStatus`/`runsByState`/`jobsByState` computed and thrown away; chart tokens + recharts unused. "12 active runs" can't reveal 9 are `waiting_for_human`. Fix: compact run-state + worker-status breakdown (stacked bar/donut) using chart-1..5, per-series labels+values (never colour-alone). → **colorize**

**[P2] Flat hierarchy: action items aren't elevated.** Four equal tiles; "Approvals Pending" is the 4th, only shifts amber when >0 (`:166`); failed runs get no summon. Fix: when approvalsPending>0 or failures exist, render a bolder banner/tile with icon+count+link above the neutral counts. → **bolder**

**[P3] Rationed cyan spent on navigation (One Signal Rule).** Header primary button glows cyan with a color-mix halo (`:108-113`) but only links to /workflows — duplicating the sidebar + "All workflows" link (`:283-288`). Fix: demote to secondary/outline (or drop); reserve cyan glow for live status. → **quieter**

**[P4] Hover-only "Open" affordance invisible on touch/keyboard.** `opacity-0 group-hover:opacity-100` (`:318`). Fix: reveal on group-focus-within too; persistently faint on coarse-pointer. → **harden**

## Cognitive Load: MODERATE (diffuse, not spiked)
No single >4-option decision point. Load comes from flat equal-weight tiles + dense `[10px]` mono metadata, not any complex control.

## Persona Red Flags
- **Sam:** metric tiles carry meaning via tinted number (green/amber/red `:32-37`) with **no icon and no text label** for well/degraded — colour-blind can't tell healthy from warning at a glance. StatusPill dot is `animate-pulse` unconditionally (no `prefers-reduced-motion`).
- **Jordan/customer:** h1 "Mission Control" ≠ doc title "Dashboard · Atlas Control"; "your worker fleet" is jargon; empty tenant hits three "No … yet" dead-ends with no on-ramp.
- **Casey (mobile):** reflow genuinely good, but four tiles stack tall and push Recent Runs below the fold; `[10px]` mono tiny on phone; hover-only "Open" never appears on touch.

## Minor
Route title ≠ h1; unify loading idiom (polish); workers query has no `limit` but client-slices to 5 (`:263, 95`) — full fleet crosses the wire; no staleness cue on a "live view"; no tone legend.

## Questions
1. Given full runsByState/workersByStatus is handed to you, why a four-number dashboard over a distribution one — overview or nav page with counters? 2. When approvalsPending>0 a human is blocked on this user — why is that the 4th equal tile? 3. If you deleted the cyan nav button, what's lost — and what could the reclaimed cyan let a *running* state say?
