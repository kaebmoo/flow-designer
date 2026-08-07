---
target: conversations (src/routes/_app/conversations.tsx)
total_score: 30
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
timestamp: 2026-08-07T06-35-02Z
slug: src-routes-app-conversations-tsx
---
Method: dual-agent (A: design-review · B: detector+grep). Browser overlay skipped — no browser-automation tool this session.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Loading + loaded-count shown, but filtered count never shown; sort/ceiling truth only at the bottom |
| 2 | Match System / Real World | 3 | Accurate but operator-internal vocab ("grouping record", "workspace key", "session binding") leaks to customers |
| 3 | User Control & Freedom | 3 | Dialog cancel + non-destructive list good; filter has no clear affordance, no column sort |
| 4 | Consistency & Standards | 2 | Hand-rolled empty div + window paragraph diverge from shared EmptyHint/WindowNotice used by sibling pages |
| 5 | Error Prevention | 4 | Required-title gate, disabled submit, role gate, forbidden-aware MutationError (`:251-259`) |
| 6 | Recognition over Recall | 3 | Filter placeholder names searchable fields; columns labelled |
| 7 | Flexibility & Efficiency | 2 | No filter-focus shortcut, no sort, no filtered count; client filter can't reach beyond the 100 window |
| 8 | Aesthetic & Minimalist | 3 | Calm/token-clean, but closing caveat is a four-fact run-on repeating "no server-side search" |
| 9 | Error Recovery | 4 | AtlasErrorState + retry; role-explaining mutation error |
| 10 | Help & Documentation | 3 | Strong inline explanation; no link to docs/ATLAS_LIMITATIONS.md |
| **Total** | | **30/40** | **Good** — honest but the honesty is buried and forks the shared components |

## Design Specificity Verdict
Genuinely honest, non-generic: Atlas constraints (no paging, no detail, no edit/delete) baked into copy and the docstring (`:30-44`), machine values in mono. But honesty is delivered as a dense muted footnote *below* up to 100 rows, and the page hand-rolls its empty state + truncation notice instead of the shared EmptyHint/WindowNotice its siblings use — quieter and less consistent than the system it lives in. And one copy line over-claims (P1).

**Deterministic scan:** detector clean (0). Token-clean. Not a semantic table here (list/card), `role="alert"` on form error only. The 100-cap IS surfaced in code + user copy (`:33,34,157`). No icon-only unlabeled buttons.

## Priority Issues
**[P1] The truncation notice over-claims — contradicting the system's own hedge.** At `:158-159` when `mayHaveMore` the copy asserts "older conversations exist that the API cannot list." But `mayHaveMore = items.length >= 100` (`atlas-reads.functions.ts:305`) — exactly 100 total is indistinguishable from >100. Shared WindowNotice deliberately says older entries "**may** exist" (`window.tsx:34`). This asserts rows that may not exist — the exact dishonesty the shared component avoids. Fix: restore the "may" hedge; delegate to WindowNotice. → **clarify**

**[P2] The completeness/ceiling truth is below up to 100 rows.** The mayHaveMore warning sits at `:156-164`, after the whole table; nothing at top signals the cap. The single most important limit is the least visible thing. Fix: when mayHaveMore, hoist a compact indicator next to the filter (`:90-107`), amber + icon + label. → **bolder**

**[P3] Filtered result count never surfaced.** `:103-106` always prints total loaded even while `filtered` (`:57-65`) drives the table. No "12 of 100 match." Fix: show filtered vs total dynamically in an `aria-live="polite"` region. → **clarify**

**[P3] Divergence from shared list primitives.** Hand-rolled empty (`:110-115`, `bg-card`) vs EmptyHint (`bg-highlight/[0.02]`); hand-rolled window paragraph (`:156-164`) vs WindowNotice. The P1 over-claim is a direct symptom of forking the notice. Fix: extend WindowNotice for the conversation caveats and adopt it + EmptyHint. → **distill**

## Cognitive Load: LOW–MODERATE
No >4-option decision points. Dragged up by the bottom caveat run-on and completeness ambiguity (is the list complete? answer is buried).

## Persona Red Flags
- **Alex:** no column sort; no filter-focus shortcut; no filtered count; client filter only spans the 100-row window — older conversations unreachable, hint buried at bottom. The search-shaped box implies reach it can't deliver.
- **Sam:** real table semantics (`<table>/<thead>/<th>`, page.tsx:73-83), non-interactive rows (no trap) — good. Gaps: `<th>` lacks `scope="col"`; filtering produces no `aria-live` count; truncation notice is static text, not a status region.
- **Riley:** 0 items handled; exactly 100 triggers the over-claim (P1 bites hardest here); long title/company/workspaceKey cells have no truncation/max-width (`:129-141`) — blow out the column.

## Minor
`<th>` missing scope=col; empty-state token drift (bg-card vs bg-highlight); create success is silent; filter has no clear/reset (×); "no server-side search" stated twice; Updated header doesn't say it's the sort key.

## Questions
1. If Atlas surfaces only the newest ~100, is a client-only filter honest, or does the search-shaped input imply reach the user can't have — should the field itself carry the ceiling caveat? 2. Read-mostly records with no detail view — is a full-width DataTable right, or a lookup/verify affordance? 3. Does a tenant have any model for "workspace key" or "session binding" — which columns/copy to rewrite for the customer?
