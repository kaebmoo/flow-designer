---
target: workflow canvas editor (src/routes/_app/workflows.$id.tsx)
total_score: 33
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
timestamp: 2026-08-07T06-13-38Z
slug: src-routes-app-workflows-id-tsx
---
Method: dual-agent (A: design-review · B: detector+grep evidence)
Note: browser/overlay visualization skipped — no browser-automation tool exposed this session (not a degraded run; both sub-agents ran isolated).

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | Dirty/saving/validation/run-state/conflict/recovery banners are exemplary |
| 2 | Match System / Real World | 3 | `worker_1` ids and `manager_decision_v1` schema names read machine-first for an external customer |
| 3 | User Control and Freedom | 3 | Great confirms + nav blocker + conflict keep/reload, but no undo/redo; Auto-arrange irreversible |
| 4 | Consistency and Standards | 3 | Bespoke "View runs" pill off the button/radius scale; fixed `w-80` inspector contradicts DESIGN's "resizable" |
| 5 | Error Prevention | 4 | Illegal-connection block, start-node guard, submit latch, expected_version concurrency — outstanding |
| 6 | Recognition Rather Than Recall | 4 | Palette names the four absent concepts; inline hints; clickable Checks jump to node |
| 7 | Flexibility and Efficiency | 2 | No undo/redo, no multi-select/copy-paste, no keyboard edge creation, nodes not tabbable |
| 8 | Aesthetic and Minimalist | 3 | Worker inspector is ~12 flat fields; toolbar wraps under 4 buttons + 2 inputs |
| 9 | Error Recovery | 4 | Verbatim Atlas errors, 409/400 guidance, localStorage draft recovery, conflict resolution |
| 10 | Help and Documentation | 3 | Superb inline help + Atlas-facts tables, but no link to the shipped bilingual guides, no first-run guidance |
| **Total** | | **33/40** | **Good** — held back almost entirely by keyboard a11y + power-user efficiency |

## Design Specificity Verdict

**Start here.** Behaviorally this is **strongly authored for Atlas, not category-interchangeable.** Exactly four node kinds because the executor accepts four; conditions-on-edges instead of ports; a fail-closed refusal to open an unparseable graph; a synchronous double-submit latch built precisely because `POST /api/workflow-runs` has no dedupe key; a PII warning on `sample_input` because it can leave in a pack. That is craft tied to the real machine.

**Visually it is only moderately specific.** At rest the canvas is a competent dark React-Flow surface whose "Air Traffic Obsidian" identity lives almost entirely in tokens, not in an authored aesthetic — the cockpit is very calm, and a large graph leans on four small icon tiles for legibility at zoom.

**Deterministic scan.** The detector fired exactly one rule, `design-system-font-size` (advisory), **28 times** — all arbitrary `text-[Npx]` off the DESIGN.md ramp: workflow-inspector.tsx ×13, workflow-interface-panel.tsx ×8, workflow-editor.tsx ×5, workflow-node.tsx ×2 (incl. the 9px minimum), route file ×0. No color/contrast/layout rule fired. This corroborates the typography finding below. **Assessment B's grep-based "zero accessibility attributes" claim was a false negative** (its greps hit a filename-quoting bug) — the surface actually carries 42 aria/role/sr-only/label hooks, and "Never colour alone" is genuinely implemented.

## Overall Impression

This is a genuinely well-engineered editor — its status, error-prevention, and recovery work is top-tier and clearly built by someone who respects the backend. The single biggest opportunity is that **the primary creative act (connecting nodes) is mouse-only**, which quietly makes graph authoring operator-only and collides with two product commitments: WCAG 2.1 AA and "two audiences, one UI."

## What's Working

1. **Atlas-specific error prevention at the start boundary.** The `submitting` ref latch (`workflow-test-run-dialog.tsx:652, 890-901`) exists because Atlas has no run dedupe — a double-click would burn two workers' budget. A safeguard invented for this backend, not boilerplate.
2. **Fail-closed unparseable graph (`workflows.$id.tsx:219-265`).** Refusing to edit rather than silently saving back a parsed subset (which would delete the rest) is rare honesty that serves the "show the real system, including its limits" principle.
3. **Never-colour-alone actually implemented.** Node run-state ring pairs hue + icon + a mono state token (`workflow-node.tsx:89-110`); the issue dot carries `sr-only` text (`workflow-editor.tsx:825`); the issue marker is `role="img"` + `aria-label` (`workflow-node.tsx:95-96`). The DESIGN rule lives in the code.

## Priority Issues

**[P1] Keyboard & screen-reader users cannot build or traverse the graph.**
- **Why it matters:** Edge creation is drag-only (`onConnect`); React Flow nodes aren't in the tab order (only the Checks list reaches nodes that *have* an issue); `role="application"` on the canvas suppresses SR browse mode with no exposed shortcuts, and only Delete/Backspace is bound. WCAG 2.1 AA (2.1.1 Keyboard, 4.1.2 Name/Role/Value) is an explicit product bar, and this UI is shared with external customers — mouse-only authoring breaks "two audiences, one UI."
- **Fix:** make nodes tabbable with roving focus; add a keyboard connect flow (select source → inspector "Connect to…" listing valid targets from `isConnectionAllowed`); expose an accessible node/edge list; document canvas keys in the canvas `aria-label` or a help affordance.
- **Command:** `/impeccable harden`

**[P2] Inspector field overload / no progressive disclosure.**
- **Why it matters:** Worker/manager routing is ~12 flat fields (`workflow-inspector.tsx:254-414`); Policy "Limits" is 6 numeric fields (`:1021-1042`). Violates chunking (≤4/group) and progressive disclosure — the surface's biggest cognitive valley and where a customer is most likely to stall.
- **Fix:** split into "Prompt", a collapsed-by-default "Routing (advanced)" (worker/workspace/role/model/company/tags), and "Execution & budget"; collapse allow-lists in Policy.
- **Command:** `/impeccable distill`

**[P2] No undo/redo for graph edits.**
- **Why it matters:** Node/edge/field edits and Auto-arrange have no in-session undo (only deletions are confirmed). A canvas editor sets the native Cmd/Ctrl+Z expectation; an accidental rename or field wipe is unrecoverable.
- **Fix:** an in-memory history stack over the semantic `graph`/`policy`/layout with Cmd+Z / Shift+Cmd+Z; at minimum an "Undo auto-arrange."
- **Command:** `/impeccable harden`

**[P3] Sub-AA type sizes / reading strain (detector-corroborated).**
- **Why it matters:** 28 arbitrary `text-[9-11px]` values, much of it uppercase mono in muted haze-grey (`oklch 0.72`) over card (`oklch 0.22`) — node hint 10px, header meta 10px, Checks 11px, mono status 9px. Small muted metadata at these sizes is exactly where AA 4.5:1 fails, and it's the long-session reading valley.
- **Fix:** raise the mono-metadata floor to ~11–12px for anything carrying real values; verify haze-grey/muted contrast at each size; revisit the DESIGN mono scale (0.625rem/9px) for body-level use.
- **Command:** `/impeccable typeset`

**[P3] Token / consistency drift vs the design system.**
- **Why it matters:** "View runs" is a hand-rolled pill off the button/radius scale (`workflows.$id.tsx:234-240, 283-289`) instead of `buttonVariants`/Link; the inspector is fixed `w-80`, contradicting DESIGN's "resizable inspector panel"; canvas handles are muted-foreground dots (cyan only on hover) vs DESIGN's "10px cyan dots." DESIGN's token-discipline is explicit; drift erodes the one-system feel.
- **Fix:** route the pill through the shared button/link variants + radius scale; make the inspector resizable (or correct DESIGN); reconcile the handle spec.
- **Command:** `/impeccable polish`

## Cognitive Load

**MODERATE (2–3 checklist failures).** Fails **chunking** (worker inspector ~12 fields under one header) and **progressive disclosure** (inspector, interface panel, and policy render every field at once; nothing collapses "advanced"). **Decision point >4 options:** the top action zone spans two rows — page header (Export pack, View runs, Delete) *plus* editor toolbar (Auto-arrange, Save, Check against Atlas, Test run) = **7 primary actions** competing at the top of the screen.

## Emotional Journey

- **Peak:** the Test Run dialog — the "This starts a real Atlas run … no dry run and no undo" cost box (`workflow-test-run-dialog.tsx:840-847`), the double-run latch, focus restoration, and version pinning make the single highest-stakes moment feel controlled and honest.
- **End:** starting a run navigates to the real `wfr_…` detail; a successful save re-baselines to "Saved." Clean closure.
- **Valleys:** bare first-run empty canvas (no model of what "good" looks like); the 12-field worker inspector overwhelm; a keyboard/SR user hitting a wall the instant they try to connect two nodes; sustained 9–11px muted-text reading strain.
- **Reassurance at high stakes:** delete-node confirm counts the edges removed; delete-workflow confirm states the cascade + irreversibility; unsaved-changes blocker + beforeunload. Strong. Soft gap: Auto-arrange repositions everything with no undo.

## Persona Red Flags

**Alex (Power User):** No undo/redo after a mis-edit; no multi-select, copy/paste, or duplicate; Auto-arrange wipes hand-placed layout irreversibly; every edge is a mouse drag with no quick-connect. Disabled Save/Test-run reasons live in `title` tooltips that never surface on keyboard focus or touch.

**Sam (A11y / keyboard / SR):** Cannot draw an edge without a pointer (`onConnect` drag-only). Cannot select an issue-free node by keyboard (nodes not focusable; Checks list only links problem nodes). `role="application"` canvas exposes no operating instructions. Tiny muted type is a low-vision barrier. Disabled-button rationale is `title`-only. Concrete 2.1.1 / 4.1.2 failures. (Note: banners, the node issue marker, and status rings ARE properly labeled — the gap is specifically canvas *interaction*, not the whole surface.)

**Riley (Stress Tester):** Excellent on the paths that matter — empty graph disables Save correctly, unparseable graph fails closed, refresh mid-edit recovers a draft, concurrent save shows conflict/keep-reload. Weak points: a **huge graph** renders all nodes/edges/Checks/orphans unvirtualized (PRODUCT's "bounded by construction" spirit not applied to these lists), and Auto-arrange is an unbounded synchronous main-thread layout.

**Priya (External Customer — project-specific persona):** Logs into the *same* editor as operators but doesn't know Atlas internals. Hits `worker_1`-style ids and `manager_decision_v1` schema labels with no glossary; can't build a graph on her keyboard/tablet; sees a bare empty canvas with no template or example; has no link to the bilingual guides that would orient her. The editor is legible to an operator who already knows the model — less so to the customer PRODUCT.md says shares it.

## Minor Observations

- Canvas handles render muted-foreground, cyan only on hover — arguably better cyan-rationing than DESIGN specifies, but a doc/impl mismatch worth reconciling.
- Node `hint` is `truncate`d at `w-60` — "quorum 3 of 5 · 4 parallel paths" will clip.
- Toolbar Description Textarea is `rows={1}`/`h-8` — multi-line descriptions aren't visible while editing.
- Disabled-state reasoning uses `title=` throughout — prefer `aria-describedby` or inline text for keyboard/touch users.
- `WorkflowPackImportDialog` isn't composed into this route (export is) — confirm the import entry point exists elsewhere.

## Questions to Consider

1. If external customers use this exact editor and connecting nodes is mouse-only, has graph authoring de facto become operator-only — quietly violating "two audiences, one UI"?
2. The surface is brilliant at *explaining* Atlas's limits in prose, yet omits undo and keyboard graph-building — is "faithful window" being stretched to excuse client affordances that Atlas's statelessness doesn't actually forbid?
3. DESIGN rations cyan to "live/primary," so at rest the canvas is near-monochrome with tiny muted labels — is the cockpit *too* calm, forcing scanability of a large graph onto four small icon tiles at zoom?
