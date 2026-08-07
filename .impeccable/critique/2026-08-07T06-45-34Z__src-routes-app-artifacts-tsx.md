---
target: artifacts (src/routes/_app/artifacts.tsx)
total_score: 31
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-08-07T06-45-34Z
slug: src-routes-app-artifacts-tsx
---
Method: dual-agent (A: design-review · B: detector+grep). Browser overlay skipped — no browser-automation tool this session.
NOTE: the premise "Atlas has no global artifact list" is STALE — docs/ATLAS_LIMITATIONS.md:545 records it RESOLVED in Atlas 5c08ee3 (2026-07-23); there is now a bounded GET /api/artifacts, and this page treats it correctly (a "newest-first window", not a complete ledger).

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | total/window/pending-per-row shown; large downloads give only a static "Downloading…", no progress |
| 2 | Match System / Real World | 3 | Clear prose, but customer-facing jargon (wfr_…, collect_files, file_ref, job_…) |
| 3 | User Control & Freedom | 3 | Clear button, deep-linkable filters, Back/Forward re-seeds; no offset paging (Atlas limit) |
| 4 | Consistency & Standards | 4 | Reuses DataTable/PageHeader/states, mono discipline held |
| 5 | Error Prevention | 3 | Filters can't err; no size guard before a potentially huge download |
| 6 | Recognition over Recall | 2 | run/job/key filters demand an exact id typed from memory; only kind is recognition |
| 7 | Flexibility & Efficiency | 3 | URL-param filters + limit chips serve operators; nothing for the browsing customer |
| 8 | Aesthetic & Minimalist | 3 | Clean/calm, but cyan-on-every-key dilutes the accent |
| 9 | Error Recovery | 4 | AtlasErrorState splits forbidden/not-found/retryable; download error a titled role=alert |
| 10 | Help & Documentation | 3 | Empty state explains collect_files, footer explains windowing, preview dialog explains metadata-only |
| **Total** | | **31/40** | **Good** — honesty grounded, colour discipline not |

## Design Specificity Verdict
Unusually honest: never implies a complete ledger, labels itself a "newest-first display window", footer (:222-226) says "latest N of TOTAL … the complete set of one run stays on its run detail page, which Atlas serves untruncated." Exemplary faithfulness. Reads as genuine Air Traffic Obsidian (mono machine-voice, tonal DataTable) but breaks the One Signal Rule by painting every Key cell cyan (:163).

**Deterministic scan:** detector clean (0). Token-clean. a11y 3 aria-/2 role= (role=group + aria-pressed chips :68,85,337; labelled inputs via shadcn Label :266-294). Artifacts are Atlas-side filtered (kind/run/job/key pushed to GET /api/artifacts), run id NOT required. Download is programmatic (out-of-file hook); `<th>` scope not in this file (column-config component). 1× text-[10px].

## Priority Issues
**[P1] Preview dead-end references a Download button that isn't there.** Non-downloadable artifacts render only Preview (artifact-actions.tsx:49-61); if preview payload is null the dialog says "available through Download instead" (:154-156) but that row has NO Download. A literal dead end. Fix: for null-preview non-file rows, say "This artifact has no inline content" and drop the Download reference (or expose a valid fallback). → **clarify**

**[P1] Huge `file_ref` downloads buffer fully with no guard or progress.** Client reads `response.blob()` then createObjectURL (use-artifact-downloads.ts:38-42); proxy buffers all bytes (api.artifacts.$id.content.ts:67-71); only a static "Downloading…". ATLAS_LIMITATIONS.md:524 warns to stream not buffer. A large file hangs the tab, doubles memory. Fix: stream the proxy; soft size-threshold warning before a large fetch; aria-live "Downloading {key}". → **harden** / **optimize**

**[P2] Cyan overuse breaks the One Signal Rule.** Every Key cell is text-primary (:163), on top of active chips + link hovers. Fix: keys in ice-white/foreground mono; reserve cyan for the active chip + live affordances only. → **quieter** / **colorize**

**[P2] "Find my artifact" has no browsing path for someone without an id.** Only filters beyond kind are exact run_id/job_id/key text inputs (:265-300); no substring/name/date search (Atlas limit), no offset past 500. Jordan/customer who doesn't know a run id can only browse the newest window. Fix: guidance linking to Runs ("find the run first, then open its artifacts"); surface inline that name/date search isn't available rather than empty inputs implying it. → **onboard**

**[P3] Table + progress a11y gaps.** `<th>` cells lack scope="col" (page.tsx:77-83); download-in-progress changes button text but emits no aria-live. Fix: add scope; announce download start/finish via a polite live region. → **harden**

## Cognitive Load: MODERATE
One >4-option decision point: kind chips (all + 6 = 7, :75-83). The run/job/key exact-id form is recall-heavy.

## Persona Red Flags
- **Jordan/customer:** cannot locate an artifact without an exact wfr_/job_/key; no name/date search; window caps at 500 no offset; jargon leaks (collect_files, file_ref, wfr_…) with no gloss.
- **Sam:** strong — descriptive action aria-labels, role=group + aria-pressed chips (:68,337), labelled inputs, dialog focus capture/restore, role=status/alert. Gaps: `<th>` missing scope; no live-region for download progress; active-vs-inactive chip differs mainly by cyan/brightness (aria-pressed covers SR; visual non-colour cue weak).
- **Riley:** 0 artifacts handled; huge file → full buffer, no guard/progress (P1); non-file_ref null-preview → misleading dead-end (P1); Size column exists but never used to warn before a large/unknown fetch.

## Minor
createdAt rendered raw (:204) — customers get ISO with no relative form; placeholder "job_..." ASCII dots vs "wfr_…" ellipsis (:273,285); kind chips + limit chips visually identical adjacent pill groups distinguished only by tiny aria-labels.

## Questions
1. If Atlas can't search by name/date, is a global artifacts *page* more useful than a prominent "artifacts live on their run" pointer — or does the page imply findability it can't deliver? 2. If you strip cyan to "live only," what on this page is ever live — should the accent appear here at all? 3. The Size column is decorative — would it earn its place by gating downloads (warn above N MB), turning metadata into error prevention?
