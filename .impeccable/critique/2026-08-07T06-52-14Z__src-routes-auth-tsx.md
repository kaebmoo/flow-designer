---
target: auth login (src/routes/auth.tsx)
total_score: 30
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-08-07T06-52-14Z
slug: src-routes-auth-tsx
---
Method: dual-agent (A: design-review · B: detector+grep). Browser overlay skipped — no browser-automation tool this session.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | spinner "Signing in", live countdown, inline error, pendingComponent on session check |
| 2 | Match System / Real World | 2 | "Atlas control plane"/"Authenticate against" is operator dialect, opaque to a customer |
| 3 | User Control & Freedom | 2 | uncontrolled fields preserve input (good), but no forgot-password / no escape from lockout |
| 4 | Consistency & Standards | 3 | autoComplete correct, tokens clean; error block omits the icon sibling AtlasErrorState always pairs |
| 5 | Error Prevention | 4 | empty-field guard, noValidate + own validation, POST-not-GET stops URL/history leak, trims username |
| 6 | Recognition over Recall | 4 | persistent visible labels (not placeholder-only), autofill wired |
| 7 | Flexibility & Efficiency | 3 | autoFocus, autoComplete, Enter-submits; no show-password toggle |
| 8 | Aesthetic & Minimalist | 4 | calm, exactly enough, on North-Star |
| 9 | Error Recovery | 3 | clear non-leaky messages + honest countdown; but no recovery path and no icon |
| 10 | Help & Documentation | 1 | no help link, no support contact, no "contact your administrator" for a locked-out customer |
| **Total** | | **30/40** | **Good** — exemplary security-UX, but jargon + no help at the first impression |

## Design Specificity Verdict
Disciplined, on-brand login — not a template: near-perfect token discipline, mono eyebrow + rationed cyan land the cockpit read, and the security engineering (uncontrolled inputs, method="post", form.reset(), queryClient.clear()) is exemplary + commented. The gap is audience, not craft: every word is operator-jargon ("Atlas control plane", "Authenticate against") — betrays "two audiences, one UI" at the exact first-impression moment a customer meets the product.

**Deterministic scan:** detector ×4 font-size (all `text-[0.7rem]` @ 141,170,191,238 — rem not px). Token-clean. a11y strong: 6 aria-, 1 role=, aria-live=1, 2 `<label>`+htmlFor+aria-invalid+aria-describedby (both inputs labelled/associated). Focus via `focus:` (6). **TOKEN LEAK CHECK CLEAN** — no localStorage/sessionStorage/document.cookie/token/bearer/URL writes; method="post" keeps credentials out of URL/history; bearer never touches this component (httpOnly-cookie model). Error announced (role=alert normal / role=status+polite rate-limit).

## Priority Issues
**[P1] Rate-limit countdown floods the screen reader.** The aria-live="polite" region (:209-217) renders a message that changes every second because retrySeconds decrements on a 1s interval (:49-56) — queues an announcement every second for the full 30-60s lockout, burying Sam. Fix: keep the live-updating countdown on the disabled button only (visual); announce ONE stable sentence in the status region ("Login temporarily rate limited; wait before retrying"), or gate re-announcement to milestones. → **quieter** (then **harden** the a11y contract)

**[P1] First-impression copy is operator-only.** "Atlas Control" (:141-143), "Authenticate against the Atlas control plane." (:145-147), footer "Atlas is the authority for every permission" (:238-240). PRODUCT Principle 3 requires screens to read safely for a customer; a tenant sees infra dialect and no product identity. Fix: lead with the product name; customer-legible subtitle ("Sign in to view and operate your workflows"); demote/operator-gate the infra footer. → **clarify**

**[P2] No recovery path on failed login (Help&docs = 1/10).** On unauthorized there's only "Incorrect username or password." (:130) — no forgot-password, no "contact your administrator", no support link. A locked-out customer/first-timer has nowhere to go. Fix: a quiet persistent help affordance ("Trouble signing in? Contact your Atlas administrator") + a reset link if Atlas supports it. → **onboard**

**[P2] Error block is colour-leaning + inconsistent with sibling states.** The error `<p>` (:209-217) signals failure via text-destructive + tints, NO icon, while sibling AtlasErrorState always pairs an AlertTriangle (states.tsx:157). Also a plausible AA contrast miss: text-destructive (alert-red) as 14px on dark tint. Fix: add a leading icon (aria-hidden); verify red text hits 4.5:1 or use a lighter destructive-foreground. → **colorize**

**[P3] Human labels set in machine voice.** "Username"/"Password" labels use font-mono uppercase (:170,191). Machine-Voice reserves mono for actual Atlas values. Fix: accept as a deliberate cockpit motif + document, or move to Inter Display text-xs per the Label token. → **typeset**

## Cognitive Load: LOW (the surface's biggest strength)
No decision point >2 options; no >4-option branch. Only mild load is the recovery-on-failure decision (no path offered) + brand orientation for customers.

## Persona Red Flags
- **Jordan:** two fields + one button + autofocus = obvious; but no recovery route and no product orientation — "Atlas control plane" may read as "wrong site". Dead-end on failure + jargon.
- **Sam:** labels associated, aria-invalid + aria-describedby wired, role=alert/status correct, autoComplete correct. Red flags: per-second live-region flooding (P1); autoFocus moves focus without warning (tolerable on a single-purpose page).
- **Casey:** full-width button, max-w-sm centered, autofill/passkey triggers — good. Red flags: no show-password toggle (masked thumb-typos costly); verify inputs render text-base on mobile to avoid iOS zoom.

## Security-UX note
CLEAN. No token/secret in any client-readable location; password read from DOM via FormData at submit, never in React state; form reset() on success + rate-limit; method="post" keeps credentials out of URL/history; bearer never appears here (server-side httpOnly cookie). Nothing to flag.

## Minor
No product/brand mark/logo (:140-148) — thin first impression for customers; no caps-lock hint; loader error surfaces error.message raw (:26); footer spends attention on infra philosophy not the user's task.

## Questions
1. If a customer's first screen says "Authenticate against the Atlas control plane," have you told them this product isn't for them before they type a character? 2. Why does the accessibility affordance (aria-live) become the thing that punishes the accessibility user during rate-limit? 3. If Atlas is sole auth authority with no self-serve reset, whose job — in this UI — is it to tell a locked-out customer where to go?
