---
target: deliveries (src/routes/_app/deliveries.tsx)
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-08-07T06-35-03Z
slug: src-routes-app-deliveries-tsx
---
Method: dual-agent (A: design-review · B: detector+grep). Browser overlay skipped — no browser-automation tool this session.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Loading/pending good, but retry succeeds into silence (no toast/announce); no timestamp anywhere |
| 2 | Match System / Real World | 3 | Faithful Atlas states + "Retry webhook", but `delivered` rendered grey fights "success" |
| 3 | User Control & Freedom | 3 | Filters undoable + explicit Clear; Back/Forward re-seeds run draft (`:97-101`) |
| 4 | Consistency & Standards | 3 | Shared DataTable/StatusPill/chips, but `attemptsExhausted` computed then ignored (retry gates on label) |
| 5 | Error Prevention | 3 | Role gate + disabled-while-pending; correct no-confirm restraint, but a post-success/pre-refetch double-POST window |
| 6 | Recognition over Recall | 3 | Columns labelled, wfr_… placeholder; action column header blank |
| 7 | Flexibility & Efficiency | 2 | No bulk retry, no sort, no time column — weak triage/power path |
| 8 | Aesthetic & Minimalist | 4 | Calm, restrained, faithful copy; nothing decorative |
| 9 | Error Recovery | 3 | Inline retry error with role=alert + forbidden-specific copy (`:265-271`), but at text-[10px] |
| 10 | Help & Documentation | 2 | Subtitle + filter hint only; no explanation of what `blocked` means or why retry helps |
| **Total** | | **28/40** | **Acceptable** — faithful, but the status column (its whole point) is the least legible thing |

## Design Specificity Verdict
Design-specific, not scaffold: faithful Atlas vocab, machine-voice mono, filter chips wired to real pushed-down Atlas filters, two distinct empty states. Faithful on the trap: `blocked` is a real (rare) Atlas state from allowlist drift, not invented (`:247-249` matches `docs/ATLAS_LIMITATIONS.md:612-623`); retry semantics correct, no invented auto-retry. But two of four statuses (`delivered`, `blocked`) fall through to muted grey — the status column that should be the scan target is the least legible thing on the page.

**Deterministic scan:** detector clean (0). Token-clean. Retry guarded by `disabled={retry.isPending}` + only rendered when `retryable && canRetry`; forbidden branch names the scope. Status carries a text label (not colour-alone technically). a11y: 1 aria-, 1 role=alert; `<th>` for action column empty; error text at text-[10px].

## Priority Issues
**[P1] `delivered` and `blocked` render as muted grey (missing status tones).** `STATE_TONES` (`atlas-mappers.ts:263-287`) has no `delivered`/`blocked` entry, so `toStatusView` falls back to `muted`. `delivered` (terminal success) never gets Signal Green; `blocked` (retryable, needs attention) never gets amber — both look like an untaught "unknown" state. Fix: add `delivered:"success"`, `blocked:"warning"` (or a delivery-specific tone map). → **colorize**

**[P1] No time column on an operational triage ledger.** `DeliveryView` carries `createdAt`/`deliveredAt` (`atlas-mappers.ts:1177-1178,1194-1195`) but the table renders neither. An operator can't tell a delivery that failed a minute ago from last week, nor prioritise retries. Fix: add a Created/Delivered mono column (absolute UTC). → **layout**

**[P2] Retry succeeds into silence + double-submit window.** RetryCell (`:255-273`) reverts with no success confirmation; between settle and refetch the button re-enables at `disabled={retry.isPending}` only, so a fast second click can POST a second retry. Fix: announce success via aria-live/inline; keep disabled through refetch (or optimistically mark the row pending). → **harden**

**[P2] `attemptsExhausted` computed but ignored; retry gated on label.** Mapper computes `attemptsExhausted` ("the UI only then offers a manual retry", `atlas-mappers.ts:1173-1174,1191`) but RetryCell gates on `status.label === "failed"||"blocked"` (`:253`). Two divergent predicates; the documented rule and actual rule differ. Fix: drive the gate from `attemptsExhausted`(+blocked), or delete the dead field. → **distill**

**[P3] No bulk retry.** Allowlist drift can mark many rows blocked/failed at once; retry is strictly per-row. Fix: row selection + "Retry selected" looping the per-delivery mutation with progress/aria-live. → **adapt**

## Cognitive Load: MODERATE
>4-option decision point: status filter row = 5 chips (`:66-80`) + a separate limit-chip row. Main strain is status legibility (muted delivered/blocked collapse into each other and "unknown").

## Persona Red Flags
- **Alex:** no bulk retry, no sort, no timestamp — after allowlist drift he clicks one row at a time.
- **Sam:** retry is keyboard-reachable + errors use role=alert (good). Gaps: status is hue + bare dot + label (no per-status *icon*, unlike the canvas rings the system mandates); action `<th>` empty (`:178`); retry **success** never announced; error text at text-[10px] (contrast risk).
- **Riley:** 0 handled; all-failed → grey/red mush, no time to triage; retry spam → only isPending guards, success silent so users re-click.

## Minor
`lastError` renders raw, no wrap/truncate; `correlationId` exists but never surfaced (the field tying a delivery to downstream logs); active filter chip spends cyan for "selected"; StatusPill pulse never appears here (delivery statuses never use primary).

## Questions
1. Why does `delivered` read the same dead grey as an untaught unknown state — intentional calm, or a forgotten tone entry? 2. If the component doesn't trust `attemptsExhausted`, which predicate is the real contract and who reconciles it when Atlas changes? 3. When an allowlist fix un-blocks fifty deliveries, is one-click-per-row honest, or Atlas's ergonomics passed straight through as busywork?
