---
target: usage (src/routes/_app/usage.tsx)
total_score: 31
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
timestamp: 2026-08-07T06-45-34Z
slug: src-routes-app-usage-tsx
---
Method: dual-agent (A: design-review · B: detector+grep). Browser overlay skipped — no browser-automation tool this session.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | Loading/error/empty/default-window notice all explicit |
| 2 | Match System / Real World | 3 | "Budget units"/"job wall time"/"worker-reported" Atlas-faithful but opaque to customers |
| 3 | User Control & Freedom | 3 | Range + Clear + Back/Forward reseed; no presets |
| 4 | Consistency & Standards | 2 | `String(runs)` (:121) vs `.toLocaleString()` (:136); cost toFixed(4) summary vs toFixed(6) rows |
| 5 | Error Prevention | 4 | Untrusted URL dates fall back to "no bound", not a crash; export validated separately |
| 6 | Recognition over Recall | 2 | Bare date inputs force recall; comparing periods requires remembering prior numbers |
| 7 | Flexibility & Efficiency | 2 | CSV strong, but no presets, no period comparison, no chart for a heavy-metrics page |
| 8 | Aesthetic & Minimalist | 3 | Calm/uncluttered but flat to the point of no signal hierarchy; monochrome throughout |
| 9 | Error Recovery | 4 | AtlasErrorState with retry + explicit forbidden path |
| 10 | Help & Documentation | 4 | Excellent inline copy (default-window rationale, cap note, "meters not invoices") |
| **Total** | | **31/40** | **Good** — honest and calm, but under-designs against its own language |

## Design Specificity Verdict
Disciplined Atlas surface: faithful to the "Atlas meters, does not invoice" truth, default-window guardrail stated in-band, rendered-cap/CSV split respects the bounded-list rule. But under-designed against its own language — **zero cyan and zero amber**, so "rationed accent" collapsed into "no accent"; four identically-weighted KPI cards give no hierarchy. Honest, but communicates consumption as a flat ledger when the job wants trend/comparison.

**Deterministic scan:** detector ×1 font-size (11px @ 219). Token-clean. **No charts** (recharts available but used in no route). a11y hooks all zero in-file (shared DataTable rows are keyboard-operable). Export is `<a href download>` (:83), token server-side. 4× text-[10px].

## Priority Issues
**[P1] Mobile table clips/crams 8 columns (no horizontal scroll).** DataTable wrapper is `overflow-hidden` (page.tsx:72) with a w-full 8-col table (:163-233), no overflow-x-auto. On a phone/narrow laptop columns compress or clip. WCAG reflow 1.4.10 + "legible for a customer." Fix: `overflow-x-auto` or collapse low-priority columns into a stacked card below md; min-w so it scrolls not crushes. → **layout**

**[P2] Numbers-only where a chart would communicate consumption far better.** Totals are a single point-in-time snapshot; no trend/shape; recharts + chart-1..5 tokens sit unused across the app. "Understand consumption" is temporal. Fix: compact per-day bar/line (tokens/cost) above the table using chart-1 (cyan)/chart-5 (violet), axis labels + text summary (colour never alone); if Atlas returns no time-buckets, state the limitation. → **colorize** (then **delight** sparkline)

**[P2] No hierarchy or accent across four identical KPI cards.** All four TotalCards identical; page uses no cyan/amber, so nothing is primary. Fix: elevate the headline metric (Tokens or Est. cost) with a cyan hairline/label; keep the rest tonal; split the tokens cell into labelled prompt/output. → **clarify**

**[P3] Inconsistent number formatting.** `String(runs)`/`String(jobs)`/`String(budgetUnits)` lack separators while tokens uses toLocaleString(); cost 4dp summary vs 6dp rows. A "12345" beside "12,345" reads as a defect on a precision surface. Fix: toLocaleString() every integer; one cost precision convention. → **typeset**

**[P3] No date presets; period comparison is manual recall.** Two bare date inputs; Alex types ISO dates + mentally diffs. Fix: preset chips (7/30/90d, MTD) writing the URL range; consider "vs previous period" deltas. → **optimize**

## Cognitive Load: MODERATE
No >4-option decision point. High visual-hierarchy load (4 identical cards) + high mobile table density (8 cols).

## Persona Red Flags
- **Sam:** pervasive text-[10px] mono-uppercase muted labels (:153,178,254; page.tsx:79) at the legibility floor — verify contrast; Status column is text-only, no colour/icon (:186) — bare-text state; no chart today so chart-contrast N/A (because the chart is missing, P2).
- **Alex:** CSV clean + range-faithful, but no in-UI period comparison, no presets — comparing two windows = two page loads + manual math; export button only on isSuccess (:80), can't re-trigger from error.
- **Casey:** the 8-column overflow-hidden table (P1) is the headline mobile failure; KPI grid `md:grid-cols-4` reflows correctly.

## Minor
Tokens KPI packs two metrics into one slash string (:136); cost precision differs summary vs row; export hidden during load/error (:80); "budget units"/"worker-reported" unexplained for customers.

## Questions
1. If Atlas can't return time-bucketed usage, is a "trend" chart honest — or would a fabricated axis violate single-source-of-truth more than showing none? 2. Four equal cards imply four equal priorities — but auditor wants cost, operator wants runs, customer wants tokens; should the headline be role-aware? 3. The page refuses to invoice — if every operator mentally multiplies estimatedCostUsd anyway, is the disclaimer protecting the user or the product?
