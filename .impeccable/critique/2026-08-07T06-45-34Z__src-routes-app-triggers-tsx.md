---
target: triggers (src/routes/_app/triggers.tsx)
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
timestamp: 2026-08-07T06-45-34Z
slug: src-routes-app-triggers-tsx
---
Method: dual-agent (A: design-review · B: detector+grep). Browser overlay skipped — no browser-automation tool this session.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Fire/enable/delete NoticeBanner renders at top of scroll (:251) — off-screen for rows fired below the fold; no per-row progress |
| 2 | Match System / Real World | 3 | Excellent human copy, undercut by raw snake_case type tokens in the form dropdown (:899-912) |
| 3 | User Control & Freedom | 2 | Delete confirm exemplary; but **Fire has no confirmation and no undo** for a real side effect |
| 4 | Consistency & Standards | 2 | Hand-rolled buttons diverge from Button system; NoticeBanner signals tone by colour with no icon |
| 5 | Error Prevention | 2 | Strong delete confirm + validation, but fire unconfirmed, validation only on submit, no field binding |
| 6 | Recognition over Recall | 3 | Rich hints, copyable webhook path; loses a point to raw type tokens |
| 7 | Flexibility & Efficiency | 3 | Workflow filter/window/copy-path; no typeahead on ~500-option selects, no bulk |
| 8 | Aesthetic & Minimalist | 3 | Calm/tonal/on-brand, but a 7-column table saturated with text-[10px] mono |
| 9 | Error Recovery | 3 | describeAtlasError routing, dismissible banner; validation summary isn't announced |
| 10 | Help & Documentation | 4 | Exceptional inline guidance — closed-config, host-time caveat, immutable-workflow note |
| **Total** | | **27/40** | **Acceptable** — engineer-faithful, not yet pushed through a "what does the customer feel" pass |

## Design Specificity Verdict
Genuinely design-specific: reasons about Atlas's real semantics (closed configs, wholesale config replacement, host-time daily_time, no idempotency key on /fire) and encodes them as inline copy + guards. But the single most consequential act — firing a real workflow run — is the weakest-designed control on the page, and the form leaks raw machine tokens to a mixed audience.

**Deterministic scan:** detector clean (0 findings). Token-clean. a11y 2 aria-/1 role=/4 sr-only; forms use a field wrapper threading htmlFor/id (17 htmlFor / 14 id) BUT **0 aria-describedby / 0 aria-invalid** — hints/errors visually associated, not programmatically linked. Fire+delete double-fire guarded client-side (Atlas has no idempotency key). 14× text-[10px].

## Priority Issues
**[P0] Fire: real side effect, lowest-weight control, feedback off-screen.** Fire (:410-437) is an icon-only neutral Play identical to Edit; no confirmation; no per-row spinner; success/error only via NoticeBanner at the top of the scroll region (:251); double-fire guarded solely by a global isPending disable, Atlas has no idempotency key (:405-409). A row fired below the fold gives feedback the user can't see. Fix: lightweight confirm/popover for a live run; swap fired row icon to spinner; render success/error inline on the row (or anchor the banner to it); distinct affordance from Edit. → **harden**

**[P1] Type dropdown shows raw snake_case, contradicting the table.** Form select renders `workflow_run_completed` etc. (:899-912) while the table shows friendly typeLabel. Two audiences, one UI. Fix: show the label as option text; keep token as a mono secondary hint. → **clarify**

**[P1] Validation & failure blocks invisible to screen readers.** Problems summary (:940-946) + mutation-failure block (:948-959) aren't role=alert/aria-live; inputs lack aria-invalid/aria-describedby; focus not moved on invalid submit; summary can sit below the fold. Fix: role=alert both blocks, associate messages to fields, aria-invalid, move focus to summary on failed submit. → **harden**

**[P2] 500-option native selects with no typeahead.** Workflow pickers (header :194-217; form IdSelect, WORKFLOW_PICKER_LIMIT=500) hold up to 500 options in a bare select. Fix: filterable combobox, keep the "preserve unknown id" behaviour. → **optimize**

**[P2] Button system + notice inconsistency vs DESIGN.md.** Hand-rolled buttons ("New trigger" :240-247; dialog actions :962-976) diverge from the Button tokens; NoticeBanner (:106-129) carries tone by colour + a `[var(--color-success)]` literal with no icon. Fix: route through shared Button; add a tone icon to NoticeBanner. → **polish**

**[P3] Empty state is a bare table cell.** Zero triggers = plain centered cell (:267-270); EmptyHint unused. Fix: inviting empty state + primary CTA. → **onboard**

## Cognitive Load: MODERATE–HIGH
Three >4-option decision points: type select (6 raw snake_case, :899-912), artifact kind (7, :1142-1158), workflow pickers (~500 unfiltered).

## Persona Red Flags
- **Alex:** fire feedback lands off-screen; no per-row "firing…"; double-fire anxiety despite guard; tiny 10px mono for last/next timing (:330-334).
- **Sam:** unannounced validation/failure blocks + no aria-invalid/describedby (:940-959); truncated lastEventError reachable only via title (:349-356); ubiquitous text-[10px]; 500-option selects.
- **Riley:** raw type tokens opaque; interval/daily validation solid (:656-664) but surfaces only at bottom on submit; bare empty state; can double-fire before the run confirms.

## Minor
SELECT_CLASS re-implements Input inline (no Select primitive, :81-83); firePath literal hardcoded twice (:142,1222); schedule radio group lacks its own label distinct from the legend; "next fire" at 10px muted is easy to miss.

## Questions
1. If firing starts a real non-idempotent run, why is Fire the lowest-weight least-confirmed control while Delete earns a full modal — is your confirmation budget aligned with consequence? 2. Should the type chooser speak machine (snake_case) or human (labels), when one audience is a customer? 3. When every row action reports success at the *top* of a scrollable table, at what row count does the toast become invisible — the moment the operator fires again?
