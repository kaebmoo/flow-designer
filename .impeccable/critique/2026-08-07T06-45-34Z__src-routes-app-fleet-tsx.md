---
target: fleet (src/routes/_app/fleet.tsx)
total_score: 32
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
timestamp: 2026-08-07T06-45-34Z
slug: src-routes-app-fleet-tsx
---
Method: dual-agent (A: design-review · B: detector+grep, run by parent after B agent died mid-response). Browser overlay skipped — no browser-automation tool this session.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Poll banner + spinners + pills excellent, but `lastError` (:311) line-clamp-1 with no way to read the rest |
| 2 | Match System / Real World | 3 | Faithful Atlas vocab, but "thClaws worker"/"base URL" unglossed for customers |
| 3 | User Control & Freedom | 3 | Poll "cannot be cancelled" + delete no-undo (honest); surface offers no own escape hatches |
| 4 | Consistency & Standards | 4 | ControlReason/MutationAlert/FieldHint/status tokens uniform |
| 5 | Error Prevention | 4 | Best-in-class: URL canonicalisation, edit-vs-create collision split, cascade-locked confirm (:714) |
| 6 | Recognition over Recall | 2 | Per-row disabled reasons hidden in title= (:336-378); no status legend |
| 7 | Flexibility & Efficiency | 2 | No sort/filter/search on an inventory table; can't find the one unhealthy worker among 40 |
| 8 | Aesthetic & Minimalist | 4 | Calm obsidian, mono for machine values, rationed accent |
| 9 | Error Recovery | 3 | MutationAlert + load-error retry + cascade-error state; weakened by unreadable truncated worker error |
| 10 | Help & Documentation | 4 | Inline FieldHints + dialog descriptions teach Atlas upsert/cascade semantics at point of use |
| **Total** | | **32/40** | **Good** — strong semantics, gaps in a11y disclosure + power efficiency |

## Design Specificity Verdict
Genuinely designed, not scaffold: collision detection normalised to Atlas canonical form, cascade preview before delete, confirm disabled until cascade is knowable, credentials never leaving the server. Falls short on interaction polish: disabled reasons in native title=, the diagnostic lastError truncated with no way to read it, no sort/filter parity.

**Deterministic scan:** detector ×9 `design-system-font-size` (all 11px, incl. lastError line 311). Token-clean (0). a11y hooks 13 aria-/3 role=/3 sr-only, but 3 `title=` (the disabled-reason problem) and 0 aria-live. **Credentials verified server-only:** `type="password"`+`autoComplete="new-password"`, sent as `undefined` when empty (:493), client carries only `tokenSet:boolean` — no leak.

## Priority Issues
**[P1] Disabled-control reasons invisible to keyboard/SR.** `ControlReason` (:117-129) puts the whole "why disabled" in a native `title` on a wrapper span (Poll/Edit/Delete :336-378; Poll all/Add :194-213). title doesn't focus, is unreliable for SR, ~1.5s hover delay. Fix: accessible tooltip/popover (focusable + aria-describedby) or visible helper text. → **harden** (+ **clarify**)

**[P2] The diagnostic `lastError` is truncated with no way to read it.** `:311` renders it line-clamp-1 red mono, no title/expand/detail. On a health surface the last error IS the payload of an unhealthy row. Fix: expandable cell (popover/row-detail) + pair red with an icon (not colour-alone). → **clarify** + **colorize**

**[P2] Empty (0 workers) state is a dead end.** `:260` single muted sentence in a table cell; no icon, no CTA. First-run + viewer both dead-end. Fix: EmptyHint panel (already exists) with icon + role-aware CTA. → **onboard**

**[P2] Table clips instead of scrolls; no responsive strategy.** 8 columns in a `w-full` table whose wrapper is `overflow-hidden` (page.tsx:72) — overflow is clipped, silently hiding data. Fails WCAG reflow 1.4.10 + "legible for a customer." Fix: `overflow-x-auto` and/or responsive column priority. → **layout**

**[P3] No sort/filter/search on the inventory.** Alex can't sort by Status to surface unhealthy workers, filter by tag/role, or search by name. Fix: sortable headers (Status, Last Seen) + tag/status filter. → **optimize**

## Cognitive Load: MODERATE
No >4-option decision point. Heaviest load is dense explanatory copy + the 8-column table.

## Persona Red Flags
- **Alex:** no sort/filter/search; "Poll all" fires N sequential dials with only a "can take a while" banner, no per-worker progress; no bulk edit/delete.
- **Sam:** disabled reasons in title= (P1); **return-focus parity gap** — delete path uses useReturnFocus (:156,385,426) but WorkerFormDialog (:401) does NOT, so focus falls to body after Add/Edit; StatusPill is dot+word (no per-state icon); lastError red has no icon.
- **Riley:** 0 workers → dead-end (P2); unhealthy → error truncated/unreadable (P2); empty *name* → submit stays disabled with no message (only URL field self-explains).

## Minor
AlertDialogAction styles destructive via inline className, bypassing button variant; poll banner not explicitly aria-live; lastSeenAt absolute UTC only (no relative hover); "not polled" plain muted text.

## Questions
1. If the surface's value is worker health, why is `lastError` the one truncated unreadable field — should Status+Last Error be one expandable "Health" cell? 2. The delete path got useReturnFocus + cascade preview but the more-frequent Add/Edit got neither — over-invested in the destructive path? 3. For customers, does explaining Atlas's SQLite upsert + ON DELETE CASCADE reassure, or leak internals they can't act on?
