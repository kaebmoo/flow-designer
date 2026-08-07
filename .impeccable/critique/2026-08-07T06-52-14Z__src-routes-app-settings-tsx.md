---
target: settings (src/routes/_app/settings.tsx)
total_score: 33
max_score: 36
na_heuristics: 7
p0_count: 0
p1_count: 0
timestamp: 2026-08-07T06-52-14Z
slug: src-routes-app-settings-tsx
---
Method: dual-agent (A: design-review · B: detector+grep). Browser overlay skipped — no browser-automation tool this session.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | pending/error/success explicit; header names the data source (:45-47) |
| 2 | Match System / Real World | 3 | "Server time (UTC)" shows raw ISO; correct but machine-first for a customer |
| 3 | User Control & Freedom | 3 | read-only by design; retry on error present (:40) |
| 4 | Consistency & Standards | 3 | reuses shared idiom, but section is rounded-lg/px-5 vs card spec rounded-xl/p-6 |
| 5 | Error Prevention | 4 | nothing to mis-enter; refuses to fabricate destructive actions |
| 6 | Recognition over Recall | 4 | labels + source annotation + literal env-var names (:60-64) |
| 7 | Flexibility & Efficiency | n/a | no repeat-use interaction on a static read-only info page |
| 8 | Aesthetic & Minimalist | 4 | spare, calm, no wasted ink |
| 9 | Error Recovery | 4 | typed AtlasErrorState (forbidden/not-found/outage) + retry |
| 10 | Help & Documentation | 4 | explains *why* empty, points to docs/CONFIGURATION.md (:56-69) |
| **Total** | | **33/36 (≈92%, #7 n/a) — Excellent** | honest, integrity-forward; under-committed as a visual object |

## Design Specificity Verdict
Genuinely design-specific: honors Machine-Voice, semantic tokens, explicit states, and its whole reason for being is "show the real system incl. limits" — it deleted a prior revision's fabricated hostname/TLS/retention/danger-zone and says so in code (:14-24). Weakness: reads more like the list/table idiom (rounded-lg/px-5) than the DESIGN card spec (rounded-xl/p-6), and the one load-bearing message is set in muted haze-grey.

**Deterministic scan:** detector clean (0). Token-clean. a11y hooks 0 in-file (no interactive controls beyond retry). No logout/destructive action here (only a pending guard). No secret exposure. 1× text-[10px].

## Priority Issues
**[P2] First data section has no programmatic heading.** Metrics section title is a styled `<header>` (:45) while the prose section uses `<h2>` (:56); the `<dl>` has no accessible name. SR heading-nav lands on "Why nothing to configure" but never on the actual data. Fix: promote :45 to `<h2>` or aria-labelledby the `<dl>`. → **harden**

**[P2] The page's one real message is muted haze-grey.** The whole "Why there is nothing to configure here" paragraph is text-muted-foreground (:55,59-70) — a full paragraph of load-bearing explanation in the secondary/placeholder voice; AA contrast risk at text-sm on bg-card. Fix: lead sentence (or whole paragraph) in text-foreground; verify AA. → **clarify**

**[P3] No identity / role / sign-out on a page named "Settings".** Neither current user, role, nor sign-out appears (nor a pointer). Both audiences equate "Settings" with account/session. Fix: a small "Session" card with identity + role (hue+label) + sign-out entry (confirm it isn't intentionally sidebar-only first). → **onboard**

**[P3] Card token drift vs DESIGN.md.** Sections use rounded-lg + px-5 py-3 (:44-45,55); card spec is rounded-xl + p-6. On a two-card page the container IS the design. Fix: align to card spec or document the list-container idiom. → **polish**

## Cognitive Load: NEAR-ZERO (appropriate)
No decision point >4 options; the page asks the user to decide nothing except "retry?" on failure. Reading load moderate (dense muted "Why" paragraph).

## Persona Red Flags
- **Sam:** first section lacks a real heading (P2); primary prose in muted colour risks AA (P2). Positives: correct `<dl>/<dt>/<dd>`, keyboard retry, role=status/aria-live LoadingState.
- **Jordan:** "Why" section is excellent expectation-setting, but the name "Settings" over-promises control and offers no account/logout — mild disorientation.
- **Casey:** Row uses flex justify-between with a mono value + no wrap (:81-84); a long atlasVersion/ISO can crowd <360px; px-8 heavy on narrow screens.

## Minor
"Server time (UTC)" raw ISO (:51) — consider a companion relative/human rendering for customers.

## Questions
1. If Atlas exposes no settings API, should the route be "Settings" at all — or "Instance / About"? 2. Where does a customer see their role and sign out, and is here the right home? 3. When a real settings API lands, does the two-card shell scale or need a redesign?
