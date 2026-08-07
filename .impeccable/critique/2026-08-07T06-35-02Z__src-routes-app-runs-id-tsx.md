---
target: run detail (src/routes/_app/runs.$id.tsx)
total_score: 32
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
timestamp: 2026-08-07T06-35-02Z
slug: src-routes-app-runs-id-tsx
---
Method: dual-agent (A: design-review · B: detector+grep). Browser overlay skipped — no browser-automation tool this session.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | Pinned status pill, stream phase pills, poll interval, gap/compaction counts — best-in-class |
| 2 | Match System / Real World | 3 | Faithful to Atlas, but `recovery_required`/`callback-pending`/`_meta.reply.callback_url` surfaced raw to customers |
| 3 | User Control & Freedom | 3 | Superb confirms + Esc-blocked-while-pending, but no "show less", no in-page nav, no undo (honest) |
| 4 | Consistency & Standards | 3 | ~4 bespoke pill implementations; one-off "Open Workflow" button style |
| 5 | Error Prevention | 4 | Blocked-reasons pre-empt every Atlas refusal; confirms on all irreversible actions; duplicate-job warning |
| 6 | Recognition over Recall | 3 | BlockedReasons stated in-page (great), but declared/observed + unknown-event "?" rely on title= tooltips |
| 7 | Flexibility & Efficiency | 2 | No keyboard shortcuts, no jump-to-section on a ~15-section scroll, primary action buried |
| 8 | Aesthetic & Minimalist | 3 | Cyan de-rationed; 15 equally-weighted stacked sections is dense |
| 9 | Error Recovery | 4 | describeAtlasError routing; forbidden(accent) vs failure(destructive) distinction; retryable-aware |
| 10 | Help & Documentation | 3 | Inline copy is embedded docs, but no guide links, no onboarding, assumes Atlas fluency |
| **Total** | | **32/40** | **Good** — refinement problems on a genuinely bespoke surface |

## Design Specificity Verdict
Emphatically authored for Atlas — nearly every string is load-bearing Atlas truth ("Atlas returns a terminal run unchanged rather than cancelling it" `:389`; `retry_interrupted` duplicate warning `:457-509`; schema-version fallback `:735-753`). Machine-Voice rule followed with unusual discipline. Could not be lifted to another product without gutting the copy.

**Deterministic scan:** detector fired `design-system-font-size` ×7 (all in route file: 9px + six 11px non-mono). Token-clean (0 hardcoded colors). a11y hooks present (aria-live/role=status/role=alert). Streaming confirmed bounded: `MAX_STREAMS=4`, `VISIBLE_LOG_ROWS=150` via `slice(-150)`, history cap + show-more + honest "N compacted" accounting — fully honors PRODUCT's bounded-logs mandate. `run-canvas.tsx` has 0 aria (SR-opaque canvas) but A confirms accessible node/edge *tables* are provided as the equivalent.

## Priority Issues
**[P1] The primary live action is buried below the fold.** On a `waiting_for_human` run, the approve/choose/reject controls are section 11 (`:1425`), below graph/events/fields/input/interface/nodes; the header amber pill is a long un-anchored scroll from the control it implies. Fix: render a pending-approval action card near top when `state==="waiting_for_human"` (or anchor the pill to Approvals) + amber elevation on the section. → **layout** (+ **bolder**)

**[P2] Cyan de-rationed, breaks the One Signal Rule.** `text-primary` on every machine id — event type (`:1162`), nodeKey (`:1373`), artifact key (`:837`), output key (`:776`); a dead/succeeded run still glows cyan everywhere. Fix: ids in `text-foreground`/mono; reserve cyan for running/current/primary. → **colorize** (or **quieter**)

**[P3] Flat section hierarchy erases stakes.** Every SectionHeading is identical tiny muted mono (`:116-125`); action-critical sections look like reference tables. Fix: one weight/tone step for action sections; elevate on attention. → **typeset**/**layout**

**[P3] Customer-hostile vocabulary.** Raw `recovery_required`/`callback-pending`/`_meta.reply.callback_url`/`schema_version`, edge "Condition matched: true/false" (`:1516`). Fix: pair customer-facing tokens with a plain-language line; keep the mono token. → **clarify**/**onboard**

**[P3] Approve is one-click; only Reject confirms.** Choice/Approve fire immediately (`:618-641`); a mis-click advances the run into irreversible downstream work. Fix: light confirm/summary for gates with downstream side effects; use a select when choices >4. → **harden**

## Cognitive Load: MODERATE (3/8 fail)
Fails visual hierarchy (identical section headings), scannability (action location inconsistent: Run control top / Approvals §11 / Deliveries lower), and bounded-choices (approval row when a gate declares 5+ branches, `:618-641`).

## Persona Red Flags
- **Alex:** scroll tax to reach approval every live run; no shortcuts/jump-nav/deep-link; run id + current-node shown in 3 places.
- **Sam:** solid base (role=status/aria-live on stream, keyboard table rows, radix focus-trap, node/edge tables as canvas equivalent). Gaps: meaning via `title=` only (declared/observed, unknown-event "?", blocked reason); `text-[9-10px]` muted mono contrast risk; **`animate-pulse` status dot has NO `prefers-reduced-motion` guard** (none in styles.css).
- **Riley:** best-served — 0 events, thousands (capped), failed (banner+recovery), refresh mid-stream (re-seed + backoff), N parallel jobs (capped "4 of N").
- **Priya (customer):** safe but not legible — operator jargon, no translation, no doc links.

## Minor
One-off "Open Workflow" style (`:1298`); two stacked paging mechanisms in EventsSection; `errorTone` maps forbidden→amber, overloading amber (attention + AI-decision + forbidden); muted StatusPill dot is generic, not per-state glyph.

## Questions
1. Why scroll past 11 sections to reach the control the top amber pill points to? 2. If cyan means "live/primary," what does it say when every id on a dead run glows cyan? 3. Which words would a tenant have to Google before a Cancel/Reject?
