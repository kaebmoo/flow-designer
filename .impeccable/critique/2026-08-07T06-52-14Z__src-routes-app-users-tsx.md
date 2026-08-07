---
target: users (src/routes/_app/users.tsx)
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-08-07T06-52-14Z
slug: src-routes-app-users-tsx
---
Method: dual-agent (A: design-review · B: detector+grep). Browser overlay skipped — no browser-automation tool this session.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | LoadingState aria-live, pending labels ("Saving…/Minting…"), live StatusPill |
| 2 | Match System / Real World | 3 | "Mint/Revoke" + raw role tokens operator-accurate but jargon for customers |
| 3 | User Control & Freedom | 3 | Cancel everywhere, Esc blocked mid-mutation; delete permanent (stated, no undo) |
| 4 | Consistency & Standards | 2 | Focus-restore only on delete/revoke; destructive confirm uses primary variant; picker shows role, table shows roleLabel |
| 5 | Error Prevention | 3 | Self-lockout warning + datetime min guard + disabled invalid submits, but NO last-admin guard |
| 6 | Recognition over Recall | 2 | Role picker lists bare admin/operator/viewer/auditor with zero privilege explanation (:472-483) |
| 7 | Flexibility & Efficiency | 2 | No search/filter/sort/bulk on either table; unbounded unsearchable Mint user picker |
| 8 | Aesthetic & Minimalist | 3 | Strong token discipline; blemished by cyan-on-destructive |
| 9 | Error Recovery | 4 | MutationErrorText role=alert, forbidden vs outage split, clipboard-failed fallback |
| 10 | Help & Documentation | 3 | Rich self-explaining prose (hashing, 5-session cap); no doc links |
| **Total** | | **29/40** | **Good** (low) — careful secret handling, but the dangerous button looks safe |

## Design Specificity Verdict
Design-literate: fluent Air Traffic Obsidian, encodes real Atlas semantics (one-time token reveal, partial-PUT password, 5-session cap). High-stakes discipline mostly present (self-lockout warnings, no-dismiss-mid-mutation, role=alert). Two real gaps: a token violation (destructive confirms render in rationed cyan, not alert-red) and an authorization-UX blind spot (only isSelf guarded; last-admin not).

**Deterministic scan:** detector clean (0). Token-clean. a11y 8 aria-/1 role=, 8 `title=`, 0 aria-live/sr-only. **Credentials verified server-only** (password type + new-password autocomplete + sent only when non-empty; minted token in transient useState, shown once, never cached). Icon row-actions all aria-labelled. 4× text-[10px].

## Priority Issues
**[P1] Destructive confirms render in rationed cyan, not alert-red.** `AlertDialogAction` uses buttonVariants() with no variant (alert-dialog.tsx:87) → default bg-primary cyan. "Delete user" (:557) + "Revoke token" (:807) confirm buttons are runway-cyan. Double violation: breaks the One Signal Rule AND the most dangerous button looks safest. Fix: pass `variant="destructive"` to both. → **harden** (+ **colorize**)

**[P1] No last-admin / other-admin lockout guard.** Only isSelf is warned (:501,549). Demoting/deleting the *last* admin carries no warning; the org can be bricked, relying entirely on Atlas to refuse. Fix: compute admin count from users.data; amber warning when target is the last admin (mirror self-lockout copy). → **harden**

**[P2] Focus not restored after Edit/Rename/Mint.** Only Delete (:206-208) + Revoke (:312-315) use useReturnFocus; Edit/Rename/Mint drop focus to body on close. Fix: capture/restore on those openers too. → **harden**

**[P2] Role picker is bare tokens, inconsistent with table.** Raw lowercase admin/operator/viewer/auditor, no description (:472-483), while the table shows humanized roleLabel. Recognition failure at a high-stakes decision. Fix: use roleLabel + a one-line privilege hint per role. → **clarify**

**[P3] Mint "User" picker unbounded/unsearchable + copy success not announced.** User select lists every user, no search (:686-697); Copy state visual-only, no aria-live (:662-671). Fix: searchable combobox; wrap copy status in aria-live="polite". → **optimize**

## Cognitive Load: MODERATE
Two >4-option flags: role picker (4 options at threshold, no privilege hints, :472-483); Mint user picker (unbounded, unsearchable, :686-697). Tokens table 8 columns dense.

## Persona Red Flags
- **Admin:** self case handled; last-admin + other-admin demotion/deletion unguarded — only Atlas stops it; cyan "Delete user" undersells danger.
- **Sam:** icon row-actions aria-labelled (good), but focus lost after Edit/Rename/Mint (P2); copy success/failure not announced; native `<select>` OS-styled options won't match obsidian.
- **Riley:** empty state self-aware ("you're signed in, unreachable"); invalid role impossible (fixed ATLAS_ROLES); delete-self warned; gap = last-admin.

## Minor
Copy state never resets from "Copied"; asymmetric state sources (role binds user.role, status binds user.status.label); tokens table 8 cols no narrow-viewport note; native select won't inherit obsidian styling.

## Questions
1. If Atlas is sole auth authority, should the UI predict the last-admin refusal — or does silence violate Principle 4 (show the real system's limits) by hiding a foreseeable failure until after the click? 2. Is a bare `<select>` of admin/operator/viewer/auditor honest on a screen that must read safely for a customer? 3. Does a full-width cyan Delete confirm spend the one rationed signal on the action that should read as the opposite of "go"?
