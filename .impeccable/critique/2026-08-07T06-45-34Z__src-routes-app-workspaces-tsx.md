---
target: workspaces (src/routes/_app/workspaces.tsx)
total_score: 32
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-08-07T06-45-34Z
slug: src-routes-app-workspaces-tsx
---
Method: dual-agent (A: design-review · B: detector+grep). Browser overlay skipped — no browser-automation tool this session.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Loading/error/pending explicit; success is a silent dialog close |
| 2 | Match System / Real World | 4 | "Map workspace"/"resolves on the worker machine" — domain-honest, customer-safe |
| 3 | User Control & Freedom | 3 | Cancel + focus-return on delete; but form Escape dismisses mid-mutation (:392) unlike delete |
| 4 | Consistency & Standards | 3 | Delete guards isPending dismissal (:562); form dialog doesn't — same pattern, two behaviours |
| 5 | Error Prevention | 4 | Collision detection warns of overwrite before save + relabels the button (:365-373,526-530) |
| 6 | Recognition over Recall | 3 | Worker Select shows name + baseUrl (:433); directory is recall-only free text |
| 7 | Flexibility & Efficiency | 2 | No search/filter, no bulk, no shortcut; no search inside the worker Select (>4 workers) |
| 8 | Aesthetic & Minimalist | 3 | Clean/calm; the full cyan key column is the one avoidable noise |
| 9 | Error Recovery | 3 | MutationAlert keeps dialog open + real Atlas copy; form Escape-during-pending can hide a refusal |
| 10 | Help & Documentation | 4 | Per-field help is machine-honest ("Atlas never checks that it exists", :487) |
| **Total** | | **32/40** | **Good** — reads as the design system but over-spends its one rationed accent |

## Design Specificity Verdict
Design-literate, not generic CRUD: near-perfect token discipline, mono machine values, destructive/overwrite flows mapping precisely to Atlas's upsert + ON DELETE SET NULL semantics. Two specific DESIGN.md failures: an entire cyan `workspaceKey` column (:206) burns the rationed One-Signal accent as identity colour, and disabled controls explain themselves only via mouse-hover title=.

**Deterministic scan:** detector ×8 font-size (11px @ 162,168,433,452,485,499,513,516). Token-clean. a11y 8 aria-/3 role=/2 sr-only. Delete verified confirmed + isPending-guarded + focus-return; icon buttons have sr-only names.

## Priority Issues
**[P1] Cyan `workspaceKey` column violates the One Signal Rule.** Every row renders its key in `text-primary` (:206). Cyan should be ≤~10% and mean live/primary. Fix: key in `text-foreground` mono; reserve cyan for state/primary. → **quieter**

**[P1] Disabled-control reason is mouse-only (title tooltip).** `ControlReason` (:95-107) puts the explanation in a title on the disabled Edit/Delete buttons (:256-274). Not keyboard/SR-reachable — Sam never learns why. Fix: aria-describedby/aria-label on the control (aria-disabled pattern) or visible inline note. → **harden**

**[P2] Form dialog dismissable mid-mutation, inconsistent with delete.** `WorkspaceFormDialog` onOpenChange closes with no isPending guard (:392); delete blocks it (:562). Escape/overlay during an in-flight upsert discards input and hides Atlas's refusal. Fix: guard onOpenChange with `upsert.isPending`. → **harden**

**[P3] Empty / no-worker states are dead-end prose.** Zero mappings = one muted sentence (:200), no CTA; "Register a worker on the Fleet page first" (:170) is plain text, not a link. EmptyHint unused. Fix: empty state with icon + inline "Map workspace"; make "Fleet page" a real Link. → **onboard**

**[P3] Silent success + low-prominence validation hint.** Mutations resolve by closing the dialog with no confirmation (sonner Toaster ships unused); missing-field cue is `text-[11px] text-muted-foreground` (:516), not role=alert. Fix: subtle success confirmation + raise the hint/tie to submit. → **polish**

## Cognitive Load: LOW–MODERATE
One >4-option decision point: worker Select with no search (:425-439) once fleet grows. Upsert "overwrite vs create" model is moderate but the collision warning carries it.

## Persona Red Flags
- **Alex:** no filter/search over table or inside the worker Select; no shortcut; cyan key column adds scan noise.
- **Sam:** blocking — disabled Edit/Delete reasons title-only (P1). Positives: sr-only labels on icon buttons (:266,286), labelled Select (:426), focus return, role=alert/status.
- **Riley:** dup mapping handled beautifully (collision warn + relabel); bare empty state (P3); form-error visibility — dead submit button, only quiet grey micro-text explains (:516).

## Minor
Subtitle writes `workspace_key` as prose (:153), not mono; overwrite banner visually identical to stale-warning banner (both amber+AlertTriangle); no optimistic feedback during the await.

## Questions
1. If cyan means "live/primary," what on this surface actually is live — shouldn't the worker StatusPill be the only cyan, keys neutral? 2. A one-click "Overwrite existing mapping" (:527) — too frictionless for what's effectively a destructive edit to another mapping's target? 3. Delete treats mid-flight dismissal as dangerous but create/edit treats it as free — which encodes the real intent, and should both converge?
