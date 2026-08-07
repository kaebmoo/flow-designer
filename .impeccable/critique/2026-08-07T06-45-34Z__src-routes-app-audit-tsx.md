---
target: audit (src/routes/_app/audit.tsx)
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-08-07T06-45-34Z
slug: src-routes-app-audit-tsx
---
Method: dual-agent (A: design-review · B: detector+grep). Browser overlay skipped — no browser-automation tool this session.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Loading + honest summary, but no live-region on filter change and no total |
| 2 | Match System / Real World | 3 | "immutable record / newest first / inclusive" reads correctly in Atlas terms |
| 3 | User Control & Freedom | 2 | Clear + Back/Forward re-seed, but no way past the window except narrowing dates |
| 4 | Consistency & Standards | 2 | Reuses PageHeader/DateRangeForm/states, yet forks from the shared semantic DataTable |
| 5 | Error Prevention | 3 | Untrusted URL falls back safely; export validated server-side; native date inputs |
| 6 | Recognition over Recall | 1 | **No column headers anywhere** — user must recall what each mono span means |
| 7 | Flexibility & Efficiency | 3 | Presets + shareable URL + CSV, but max window 500, day-only granularity |
| 8 | Aesthetic & Minimalist | 3 | Calm/dense, but cyan on every timestamp dilutes the accent |
| 9 | Error Recovery | 4 | AtlasErrorState separates forbidden/not-found/outage with retry |
| 10 | Help & Documentation | 3 | Inline paragraph genuinely explains window, mayHaveMore, export scope |
| **Total** | | **27/40** | **Acceptable** — design-aware but not yet design-faithful, on the surface whose audience reads tables for a living |

## Design Specificity Verdict
Genuinely of this system in voice + state discipline: speaks Atlas's real limits in plain microcopy (:137-145), maps 403 to a distinct forbidden state (not a sign-out), mono for machine values. But drifts exactly where an auditor feels it: abandons the app's own semantic DataTable (page.tsx:53-129) for a headerless div/span grid, overspends cyan on every timestamp, signals the selected window by hue alone.

**Deterministic scan:** detector ×1 font-size (11px @ 113). Token-clean. a11y hooks **all zero** (0 aria/role/label/th/scope) — the entry list (:113) is a **div grid, not a `<table>`**; export region has no aria-live. CSV export is a same-origin `<a href download>` (:56-62), token stays server-side. Bounded by `limit`, no cursor/total.

## Priority Issues
**[P1] Headerless div grid, not a semantic table.** Audit rows are div/span with no header row and no table semantics (:113-136), while the app ships a semantic keyboard-correct DataTable (page.tsx:53-129). Sam hears an undifferentiated span stream; everyone must recall which mono field is actor vs action vs resource. Fails Recognition + WCAG AA on the one surface whose audience reads tables professionally. Fix: render as `<table>` with `<thead>` (Time·Actor·Action·Resource·Detail), ideally via DataTable. → **harden** + **layout**

**[P1] Window selector: colour-only state, no group semantics.** Selected window is pure cyan (:66-81); chips in a bare div, no group label, no aria-pressed, no explicit focus-visible. Never-Colour-Alone violation; SR gets three unlabeled buttons with no current-value cue. Fix: `role="group" aria-label="Window size"` + aria-pressed + non-colour selected affordance + focus ring. → **harden**

**[P1] Auditor can't obtain or verify a complete trail.** View + CSV capped at the same window (UI max 500, Atlas clamps 10000), no total, no cursor; export silently carries the truncated window (api.exports.audit-csv.ts:50-57). A silently-truncated "export" is a forensic hazard. Fix: offer larger windows (up to 10000), state near the button that export is window-bounded, warn when export will truncate (mayHaveMore). → **clarify** + **harden**

**[P2] Cyan spent on every timestamp.** `text-primary` on every row's createdAt (:116) violates the One Signal Rule. Fix: timestamps in text-muted-foreground/foreground mono. → **quieter**

**[P3] Actor/detail truncated behind title tooltip.** actor (`w-40 truncate`) + detail (truncate) reveal full text only on hover title (:117-133). Not keyboard-reachable; load-bearing forensic payload hidden from Sam. Fix: allow wrap or an accessible disclosure; full value in the accessible name. → **harden**

## Cognitive Load: HIGH memory burden
No column headers → recall column meaning. No decision point >4 options. Density high (5 cols + horizontal scroll).

## Persona Red Flags
- **The Auditor:** cannot verify completeness (no total, window capped 500, export same-capped, no cursor); destructive vs benign actions render identical foreground mono (:123) — nothing to scan for a DELETE; truncated detail hides the forensic payload.
- **Sam:** not a semantic table, no headers (:113-136); window toggle colour-only, no aria-pressed/label/visible focus (:66-81); count/filter changes not announced (summary `<p>` :137 not aria-live); overflow-x region (:113) has no keyboard-scroll affordance/label.
- **Riley:** 0 rows handled (range-aware); huge range >500 dead-ends at "narrow the dates" with only day granularity; export button shows at 0 items (:55) → empty CSV, no warning.

## Minor
Export at 0 items → empty CSV no heads-up; native date = day granularity but Atlas accepts timestamps (:39); horizontal-scroll container no tabindex/label; fixed w-44 date inputs push toward mobile "spreadsheet crush."

## Questions
1. If the auditor's job is to prove nothing is missing, why cap the window at 500 with no total/cursor — is the CSV a record or a sample? 2. Why do DELETE and READ render identically in an immutable log, when the system reserves amber/red (with icon) for exactly this? 3. Given a semantic keyboard-correct DataTable ships, what justified a headerless div grid for the one surface whose audience reads tables for a living?
