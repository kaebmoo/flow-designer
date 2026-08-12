# AI draft error UX plan — stop leaking Atlas validator strings

Status: Implemented 2026-08-12 (flow-designer `b87eb59`); dialog coverage added as
`tests/e2e/zz-ai-draft-error.spec.ts`.

Scope: `src/lib/workflow-ai-draft.ts` and
`src/components/atlas/workflow-ai-draft-dialog.tsx` only. This is stage **D2b-5**
of the Atlas-side plan
`atlas-control-plane/docs/plans/ai-draft-contract-hardening-plan.md` (§3 F5); the
root-cause fix for the underlying failures is in Atlas (stages D2b-1 → D2b-3) and
is a prerequisite for the field evidence, not for this UI change.

Line references are against `0fa2385`; re-locate by symbol if drifted.

## Why

A user typed a plain-language Thai description of a purchase-approval workflow
into **Draft with AI** and got back, verbatim:

```
workflow draft trigger at index 0 must be an object
```

That string is precise for an engineer reading `atlas/app.py` and useless for the
person who typed a paragraph of business process. It names an internal field
(`trigger`), an internal data model (`object`), and an internal index — none of
which appear anywhere in the product's vocabulary. It also implies the user did
something wrong, when the defect was in the Atlas draft pipeline.

`describeWorkflowDraftError` (`src/lib/workflow-ai-draft.ts:39-53`) passes any
Atlas message straight through as `message`, and `ActionError`
(`src/components/atlas/workflow-ai-draft-dialog.tsx:33-55`) renders it as the
alert body. Only two special cases exist today: `forbidden` (from the structured
Atlas error kind) and `needsBuilderSetup` (a regex on
`No workflow_builder worker configured`). The class of error that actually reaches
users — deterministic draft validation — has no handling and, before this work,
no test.

## Constraint that shapes the fix

The Definition of Done for stage D3 in
`atlas-control-plane/docs/plans/ai-draft-authoring-plan.md` §3 requires Atlas's
400 text be shown **verbatim**. That was a deliberate choice: these errors are the
only diagnostic signal a user can paste back to an operator, and hiding them makes
support harder.

So this plan does not replace the Atlas text. It **demotes** it: a plain-language
headline carries the meaning, and the raw string stays verbatim one click away.
Both requirements are met; neither is traded off.

## Current behavior

| Input                                                 | `message` today | Rendered as             |
| ----------------------------------------------------- | --------------- | ----------------------- |
| `workflow draft trigger at index 0 must be an object` | same string     | alert body              |
| `No workflow_builder worker configured`               | same string     | alert body + setup hint |
| `workflow_builder job failed: …`                      | same string     | alert body              |
| `{kind: "forbidden", message: "Access denied"}`       | `Access denied` | accent-styled alert     |

## Classify on the error kind, not the message text

The obvious implementation — regex the message for a `^workflow ` prefix — was
drafted first and rejected after checking it against Atlas's actual error strings:

- **False negatives.** Real deterministic validation messages that do _not_ start
  with `workflow `: `duplicate node id: …` (`atlas/workflows.py:216`),
  `unsupported workflow condition: …` (`:2477`),
  `unsupported workflow trigger type: …` (`:2056`),
  `unknown workflow trigger config key(s) for …` (`:2067`). Each would have kept
  leaking raw.
- **False positive waiting to happen.** `workflow job timed out: …`
  (`atlas/workflows.py:1827-1859`) _does_ start with the prefix and is not a
  validation error. It is harmless only by accident today — `TimeoutError` is not
  a `ValueError`, so it surfaces as a 5xx whose text
  `toClientAtlasError` already redacts. A future "make timeouts a 400" change
  would silently mislabel it.

Structured data already carries what we need. `ClientAtlasError.kind`
(`src/lib/atlas-types.ts:93-103`) is `"validation"` for every Atlas 400/422 and
something else for every other outcome; 5xx message text is replaced with a fixed
string before it ever reaches this layer (`src/lib/atlas-mappers.ts:149`), and
timeout/network/protocol failures have their own kinds. Keying off the kind is
complete today and does not drift when Atlas's validator wording changes.

## Target behavior

```ts
describeWorkflowDraftError(
  error: unknown,
  phase: "draft" | "create" = "draft",
): { message: string; detail?: string; forbidden: boolean; needsBuilderSetup: boolean }
```

Within `kind === "validation"`, in order:

1. `/No workflow_builder worker configured/i` → unchanged: message passes through,
   `needsBuilderSetup` true, no `detail`. (This test exists and must stay green,
   including for a plain `Error` with that text.)
2. `/^workflow_builder job failed/i` → builder-infrastructure headline, `detail` =
   raw text. This is an operational failure, not something the user's wording can
   fix, so it must not get the "simplify your description" advice.
3. everything else → phase-appropriate headline, `detail` = raw text, unmodified.

Every other kind, and every non-Atlas `Error`, keeps today's behavior exactly:
`message` = the text, `detail` undefined. `forbidden` semantics unchanged.

Headlines — one per phase, no per-error variants:

| Phase                             | Headline                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `draft`                           | Atlas could not turn this description into a valid workflow. Try simplifying it, or splitting it into smaller workflows. |
| `create`                          | Atlas rejected this proposal when saving it. Discard it and draft again.                                                 |
| builder job failed (either phase) | The builder worker could not finish this request. Check the worker, then try again.                                      |

Two phases because `ActionError` is reused for both `draftRequest.error` and
`createError` in the same dialog; "simplify your description" is wrong advice once
the description has already produced a proposal.

One generic headline per phase, rather than per-error copy, because the failure
set is open-ended and moves whenever Atlas's validator or the builder model
changes. Per-error copy would rot silently and hand users confident-sounding but
wrong advice. The generic headline is honest, and the exact cause is one click
away in `detail`.

`ActionError` renders `detail`, when present, inside a **collapsed** `<details>`
labelled **Technical details**, using existing design tokens and shared
primitives. Collapsed by default so the alert stays scannable; keyboard
reachable; WCAG 2.1 AA contrast preserved in both the destructive and accent
variants.

## Non-goals

- **No client-side retry.** A retry re-bills the user's model (`CLAUDE.md`:
  mutations never auto-retry). The user chooses to try again.
- **No prompt rewriting or hint injection.** Prepending schema instructions to the
  user's text is the workaround this whole work stream exists to delete.
- **No new dependency, no new component.** `<details>` plus existing primitives.
- **No change to `summarizeWorkflowDraft`, `canSubmitWorkflowDraft`, or the
  mutation layer.**

## Files

| File                                                | Change                                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/lib/workflow-ai-draft.ts`                      | `describeWorkflowDraftError` gains `phase` + `detail` and the kind-based classification                   |
| `src/components/atlas/workflow-ai-draft-dialog.tsx` | `ActionError` takes `phase`, renders the `Technical details` disclosure; both call sites pass their phase |
| `tests/unit/workflow-ai-draft.test.ts`              | new cases (below)                                                                                         |
| `docs/guides/web-user-guide-en.md` / `-th.md`       | only if they quote the old error copy                                                                     |

## Tests

Extend `tests/unit/workflow-ai-draft.test.ts`. Inputs are `ClientAtlasError`-shaped
objects unless noted:

1. `{kind: "validation", message: "workflow draft trigger at index 0 must be an object"}`
   → headline `message`, `detail` strictly equals the raw string, `forbidden`
   false, `needsBuilderSetup` false.
2. `{kind: "validation", message: "duplicate node id: gate"}` → same
   classification. This is the case a prefix regex would have missed; it is the
   reason the rule is kind-based, so it must be locked by a test.
3. `{kind: "validation", message: "No workflow_builder worker configured"}` →
   unchanged, `needsBuilderSetup` true, `detail` undefined.
4. `{kind: "validation", message: "workflow_builder job failed: builder worker exploded"}`
   → builder-infrastructure headline, `detail` set, `needsBuilderSetup` false.
5. `{kind: "server", message: "Atlas failed to process the request."}` →
   unchanged, `detail` undefined.
6. `{kind: "forbidden", message: "Access denied"}` → unchanged.
7. plain `new Error("No workflow_builder worker configured")` → unchanged; the
   existing test stays green, and `detail` is asserted undefined.
8. `phase: "create"` produces a different headline than `phase: "draft"` for the
   same validation error.

Plus one dialog-level test: given a validation-class error, the alert shows the
headline and a disclosure whose content is the raw Atlas string.

**Delivered as Playwright, not jsdom** (`tests/e2e/zz-ai-draft-error.spec.ts`).
This repo has no component-render harness — every vitest project runs
`environment: "node"` — so a jsdom test would have meant adding
`@testing-library/react` and a new config, which this plan's own Non-goals forbid
("No new dependency"). The existing browser harness needs neither and proves
strictly more: a stub worker registered under the `workflow_builder` role answers
with prose, so Atlas really runs two builder jobs, really fails
`_json_from_text`, and really returns its own 400 — the string the test opens the
disclosure to read is Atlas's, not a fixture's. Mutation-tested by reverting
`describeWorkflowDraftError` to pass the raw text through as the headline, which
turns it red.

Gate: `bun run lint && bun run typecheck && bun run test && bun run test:contract
&& bun run scan:bundle && bun run build`, then walk `docs/CHECKLIST.md` for the
touched surface. Commit as one small phase; never rewrite published history
(Lovable-connected).

## Definition of Done

- `describeWorkflowDraftError` has the `phase` parameter and the four-field
  return shape; `forbidden` and `needsBuilderSetup` semantics are identical to
  today for every input that reached them before.
- No user-facing surface renders a raw Atlas validator string as its headline;
  the raw string is still reachable verbatim in one click.
- All eight unit cases plus the dialog test pass; the full gate is green.
- Guides updated only where they quoted the old copy.
