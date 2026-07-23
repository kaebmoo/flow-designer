# flow-designer Web User Guide

flow-designer is the full operator frontend for Atlas Control Plane. It talks
only to Atlas's REST/SSE API — it holds no domain state of its own — and adds
the workflow-authoring, approval, trigger, delivery, and cross-run reporting
surfaces that Atlas's own
[embedded ops console](https://github.com/kaebmoo/atlas-control-plane/blob/main/docs/guides/web-user-guide-en.md)
deliberately leaves out.

> Atlas is still the control plane and the only source of truth; flow-designer
> owns presentation only. Every action shown here ultimately calls an Atlas
> endpoint, and Atlas enforces every permission again server-side — a role
> label in this UI is a display hint, not the real gate.

## Atlas's console vs. flow-designer

Both frontends stay in use; they cover different ground.

| Capability                                                           | Atlas's embedded console                                 | flow-designer                                                                  |
| -------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Fleet: workers & workspaces                                          | Yes                                                      | Yes (two separate pages)                                                       |
| Live per-job stream, tool-call timeline, raw events, collected files | Yes, all four                                            | Live events only, inline on a run's active job — no timeline/events/files tabs |
| Workflow definition editor                                           | No — API only                                            | Yes, a visual drag-and-drop canvas                                             |
| Run monitor + human approvals                                        | Yes (approvals decided via API)                          | Yes (approvals decided in-page)                                                |
| Triggers                                                             | No — API only                                            | Yes                                                                            |
| Webhook deliveries                                                   | No — API only                                            | Yes                                                                            |
| Global artifact ledger (all runs)                                    | No                                                       | Yes                                                                            |
| Per-run artifacts                                                    | Yes, download only                                       | Yes, download or in-page preview                                               |
| Run file upload (e.g. a contract PDF for a human gate)               | No — API only                                            | No — API only                                                                  |
| Ad-hoc job submission / handoff                                      | No — API only                                            | No — API only                                                                  |
| Solution-pack import/export                                          | No — API only                                            | No — API only                                                                  |
| Draft-from-plain-language, Explain, Repair, Suggest workers/triggers | No — API only                                            | No — API only                                                                  |
| Usage metering                                                       | Yes, plus a 7-day chart and a quota/threshold alert      | Yes, no chart, no quota alert                                                  |
| Audit log                                                            | Yes, filterable by type, rows jump to the job/run/worker | Yes, plain log, no type filter, rows are not clickable                         |
| Users & API tokens                                                   | Yes                                                      | Yes                                                                            |
| Theme                                                                | Light/Dark toggle                                        | None                                                                           |

Keep Atlas's own console open in a second tab when you need to watch a
specific job closely (its tool-call timeline and raw event log go deeper than
anything on flow-designer's Jobs page) or check usage against a quota.
Everything about building, running, and governing a workflow belongs here.

## Not here — API only

flow-designer has no UI for any of the following. They remain reachable
through Atlas's REST API (see the
[API Reference](https://github.com/kaebmoo/atlas-control-plane/blob/main/docs/specs/api-reference-en.md)):

- Submitting an ad-hoc job outside a workflow, with routing/handoff (`POST /api/jobs`).
- Uploading a file to a run, e.g. a contract for a human gate to review (`POST /api/workflow-runs/{id}/files`).
- Importing or exporting a solution pack (`GET`/`POST /api/packs`).
- Non-saving Explain/Repair drafts and Draft-from-plain-language (`POST /api/workflows/{id}/explain|repair`, `POST /api/workflows/draft`).
- Suggest-workers / Suggest-triggers helpers (`POST /api/workflows/suggest-workers`, `POST /api/workflows/{id}/suggest-triggers`).
- A dedicated "manager decision" panel with proposal/acceptance reasoning (visible via run events and audit instead — see §9).
- Supplying run-input JSON when starting a workflow run from the editor (Run starts immediately with empty input; use `POST /api/workflow-runs` directly to pass `input`).

## 1. Start the system

Prerequisites: Atlas already running (see Atlas's own guide, §1) and Bun as
the package manager (`bun.lock` is committed).

```bash
cd /Users/seal/Documents/GitHub/flow-designer
bun install
bun run dev
```

Set at least these server-only environment variables in `.env` (never prefix
any of them with `VITE_` — that would leak them into the browser bundle):

| Variable           | Purpose                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `ATLAS_API_ORIGIN` | Private Atlas origin, e.g. `http://127.0.0.1:8787`                                          |
| `SESSION_SECRET`   | Seals flow-designer's own session cookie; minimum 32 characters (`openssl rand -base64 48`) |
| `PUBLIC_ORIGIN`    | This app's own public origin, e.g. `http://localhost:3000` in local dev                     |
| `SESSION_MAX_AGE`  | Optional; session cookie lifetime in seconds (default 28800 = 8 hours)                      |

Open the origin set by `PUBLIC_ORIGIN` (`http://localhost:3000` by default in
local development) and sign in.

## 2. Sign in and sessions

**Sign in** takes **Username** and **Password** and authenticates against
Atlas. Errors are specific: wrong credentials ("Incorrect username or
password."), rate-limiting (a live countdown, e.g. "Atlas is rate limiting
login attempts. Try again in N second(s)."), or Atlas being unreachable
("Atlas is unreachable right now. Try again in a moment.").

flow-designer mints its own secure, httpOnly session cookie on top of Atlas's
bearer token — the token itself is never exposed to browser JavaScript (unlike
Atlas's own console, which keeps the token in `localStorage`).

A banner appears above the page once the session has 5 minutes or less left:
"Atlas session expires in N minute(s)." — and after it lapses: "Atlas session
expiry has passed; the next Atlas request will verify it." Sign-out, expiry,
or Atlas's 5-session-per-user cap can all end a session; the banner explicitly
says not to rely on the browser clock alone.

If Atlas stops responding while cached data is still on screen, a separate
banner reads: "Atlas is not responding. Some data may be cached and stale;
retry the affected panel before acting on it."

**Sign out** (in the sidebar footer) clears all cached data and returns to the
sign-in page — specifically so a second person signing in on the same browser
never sees the previous user's data.

## 3. Navigation

The sidebar groups every page under four labels:

| Group            | Pages                                           |
| ---------------- | ----------------------------------------------- |
| **Operate**      | Dashboard, Workflows, Runs, Jobs, Triggers      |
| **Fleet**        | Workers, Workspaces, Conversations              |
| **Data & Audit** | Artifacts, Webhook Deliveries, Usage, Audit Log |
| **System**       | Users & Tokens, Settings                        |

There are no badge counters in the sidebar. Every item is visible to every
signed-in user regardless of role; pages that need a higher role (Users &
Tokens, for instance) show a forbidden state instead of hiding the link.

## 4. Dashboard

The landing page ("Mission Control") shows four stat tiles sourced from
Atlas's `GET /api/metrics`:

| Tile                  | Shows                                                |
| --------------------- | ---------------------------------------------------- |
| **Workers Online**    | `online/total`, or "No workers registered"           |
| **Active Runs**       | current count, plus lifetime runs recorded           |
| **Workflows**         | definition count, plus how many triggers are enabled |
| **Approvals Pending** | human gates currently waiting on a decision          |

Atlas provides no 24-hour success-rate aggregate to any role, so the
dashboard does not show one (this is called out on the page rather than
faked). Below the tiles: **Recent Runs** (last 5, linking to **Runs**),
**Fleet** (last 5 workers, linking to **Fleet**), and **Workflows** (a grid of
6, linking to **Workflows**). **View Workflows** is the only header action —
there is deliberately no "New Workflow" shortcut here.

## 5. Fleet: Workers and Workspaces

Workers and workspaces are two separate pages (unlike Atlas's own console,
which shows both on one **Fleet** view).

### Workers

**Workers** lists name, base URL, role, tags, agent version (or "not
polled"), last error, status, and last seen. Managing workers (add/edit/
delete) needs the Atlas `admin` role; polling needs `admin` or `operator` — a
disabled button always shows why (e.g. "Adding, editing, and removing workers
requires the Atlas admin role — yours is viewer.").

**Poll all** re-polls every worker in sequence (a banner explains this cannot
be cancelled mid-poll). Each row has icon actions: poll, edit, delete.

**Register a worker** / edit dialog fields: **Name**, **Base URL**, **Role**
(free text), **Tags** (comma-separated), **Worker token** (leave blank on
edit to keep the stored token — Atlas never returns it to the browser). Atlas
upserts a worker by `base_url`: saving onto an existing URL during creation
warns and offers to overwrite that worker's name/role/tags; editing onto a
URL that belongs to another worker is a hard block.

**Delete worker** previews which workspaces would cascade-delete with it (or
confirms none do) before the delete button becomes clickable.

### Workspaces

**Workspaces** (`canManage` = `admin` or `operator`, a broader gate than
Workers) lists workspace key, company, owning worker (with its status),
directory on the worker, and tags. **Map workspace** / edit dialog fields:
**Worker** (select), **Workspace key**, **Directory on the worker**,
**Company**, **Tags** — upserted by `(worker, key)` with the same
collision/overwrite behavior as workers. **Delete workspace** is explicit that
job history is preserved but loses its link to the deleted workspace.

## 6. Conversations

**Conversations** is a lightweight grouping/tagging list — not a job
composer. Atlas may reuse an internal worker session for a conversation once
a worker reports one, but there is no way to submit a job from this page.

Columns: Conversation (id), Title, Workspace key, Company, Updated. **New
conversation** takes **Title** (required), **Workspace key (optional)**, and
**Company (optional)**. There is no edit or delete action — Atlas has no such
endpoint for conversations, and the list itself is a fixed latest-100 window.
A client-side filter box narrows what's already loaded; it does not query
Atlas for anything outside that window.

## 7. Jobs

**Jobs** lists every job Atlas has recorded, whether routed manually or by a
workflow. Filter by **Workflow** (dropdown), toggle **Group by workflow**,
filter by state chip (`all`, `queued`, `running`, `cancel_requested`,
`succeeded`, `failed`, `cancelled`), and choose a window (25/100/500).

Columns: Job, Prompt, Workflow (linked run + node, when applicable), Worker,
Workspace, Created, Duration, State.

Selecting a row opens a side panel: state, a **Cancel job** button, the full
prompt, a field grid (worker id, execution mode, model, session, started,
duration), routing reason, error (if any), and the assistant's output. That
output is explicitly labeled as the persisted result — **live token
streaming is not shown on this page**; it only appears inline on the **Runs**
detail page for a job behind a currently-running workflow node (§9). There
are no Stream/Timeline/Events/Files tabs here — for that level of per-job
detail (tool-call timeline, raw event log, collected files), use
[Atlas's own console](https://github.com/kaebmoo/atlas-control-plane/blob/main/docs/guides/web-user-guide-en.md#4-jobs-output-and-events).

**Cancel job** asks for confirmation ("Cancel job {id}?" / **Keep it
running** / **Request cancellation**) and explains inline when it's blocked
(e.g. the job already reached a terminal state).

## 8. Workflows

### Definitions list

**Workflows** lists every definition (name, description, status, node/edge
counts, version, last updated). **New workflow** creates the smallest valid
graph in Atlas immediately (a single `worker` node, no edges) and opens the
editor directly — there is no local-only draft stage.

**Starter workflows** offers four ready-to-use examples, each created with
one click (**Create example**): **Daily News Brief**, **Customer Complaint
Handler**, **Weekly Sales Report**, and **Blog Post Pipeline**. (These are
different from Atlas's four built-in API-level templates — News Desk,
Researcher → Writer → Reviewer, Coder → Tester → Reviewer, and
Manager-directed loop — which remain reachable only via
`GET /api/workflow-templates`.)

There is no solution-pack import/export button anywhere on this page (see
"Not here" above).

### The editor

Opening a definition opens a true drag-and-drop visual canvas — there is no
raw Graph JSON textarea anywhere in flow-designer. A left-hand palette adds
nodes; a right-hand inspector edits whatever is selected. **Delete** (top of
the editor) removes the whole definition after confirming ("Delete "{name}"?
Atlas removes the definition and cascades its triggers and run history. This
cannot be undone.").

Four node kinds, each shown on the canvas with a plain-language label rather
than its internal type:

| Internal type | Canvas label          | What it does                              |
| ------------- | --------------------- | ----------------------------------------- |
| `worker`      | **AI Task**           | Runs an instruction on a connected worker |
| `manager`     | **AI Decision**       | Chooses which connected path runs next    |
| `join`        | **Wait for branches** | Waits for branches before continuing      |
| `human_gate`  | **Human decision**    | Pauses for approval or a choice           |

Inspector fields, by node kind:

- **AI Task** and **AI Decision**: **Prompt** (substitutes `{input.x}`,
  `{artifact.key}`, `{run.x}`, `{node.x}`, `{job.x}`), **Worker id**,
  **Workspace id**, **Role**, **Model**, **Company**, **Tags**, **Execution**
  (`stream` or `callback`), **Budget units**, **Collect files**
  (comma-separated glob patterns).
- **AI Task** only: **Output artifact key**, **Output format** (`text` or
  `json`).
- **AI Decision** only: a fixed note that it must return
  `schema: manager_decision_v1`, and every outgoing edge must be
  `manager_selected`.
- **Wait for branches**: **Mode** (**All branches** / **Any branch** / **A
  set number of branches**, i.e. `all`/`any`/`quorum`); quorum adds a
  **Quorum** number field.
- **Human decision**: the section title switches between **Request approval**
  and **Ask for a choice** depending on whether choices are added. Fields:
  **Label**, **Reason**, a **Choices** list (**Add choice**, per-choice
  id/label, remove button). Fixed note: Atlas has no per-gate approver list
  and no gate timeout — the only time bound is the workflow's `max_minutes`.

Every node has a **Delete node** action, with its own confirmation.

Six edge conditions, with the canvas's exact label:

| Internal type          | Label shown                         |
| ---------------------- | ----------------------------------- |
| `always`               | **Always**                          |
| `artifact_equals`      | **Artifact equals a value**         |
| `artifact_in`          | **Artifact is one of**              |
| `manager_selected`     | **Manager selected this path**      |
| `human_selected`       | **Person chose this option**        |
| `max_iterations_below` | **Node has run fewer than N times** |

An edge leaving an **AI Decision** node can only be **Manager selected this
path**; an edge leaving a **Human decision** node with choices can only be
**Person chose this option** — the inspector only offers the legal set per
source node. Condition-specific fields: **Artifact key** + **Path** (both
artifact conditions), **Equals** (`artifact_equals`), **One of**, one value
per line (`artifact_in`), **Choice** dropdown (`human_selected`), **Counted
node** + **Maximum runs** (`max_iterations_below`). Every edge also has a
**Push files** field for file handoff between nodes, disabled until the
policy's `file_handoff` switch (below) is on.

**Run policy** (a left-sidebar button, not a tab — it swaps the inspector) is
entirely form-based:

- **Default reply**: **Workflow reply** (Absent / Explicit none / Webhook,
  with **Callback URL** + **Correlation id** / Clear stored value).
- **Limits** — labeled with Atlas's literal field names: **max_jobs** (total
  jobs a run may create), **max_iterations** (guards a graph cycle — one of
  the two ways to allow a loop), **max_attempts_per_node** (retries before
  failing a node), **max_minutes** (wall-clock budget for the run),
  **requires_human_after_iterations** (pauses for a human once a run has
  iterated this many times), **max_budget_units** (total budget units a run
  may consume).
- **Switches**: **stop_on_first_failure**, **file_handoff** (must be on
  before any edge's **Push files** takes effect).
- **Allow lists**: **allowed_worker_ids**, **allowed_workspace_ids**
  (comma-separated).

Toolbar actions (exact button text): **Auto-arrange**, **Save**/"Saving…",
**Check against Atlas**/"Checking…" (calls Atlas's
`POST /api/workflows/{id}/validate`), and **Run**/"Starting…". There is no
**Explain** and no **Repair** button, and no Draft-from-plain-language /
Suggest-workers UI anywhere (see "Not here" above).

Clicking **Run** starts the workflow immediately with empty input and
navigates straight to its **Runs** detail page — there is no Run-input-JSON
field. If a workflow's start node needs `{input.x}` values, start it through
`POST /api/workflow-runs` with an `input` object instead.

Leaving the editor with unsaved changes prompts **Discard unsaved workflow
changes?** (**Keep editing** / **Discard changes**). A crash-recovery banner
("Restore draft" / "Discard") can restore an unsaved edit from the same
browser tab after an accidental navigation or reload — this is local-only
recovery, unrelated to any AI drafting feature.

## 9. Runs

### List

**Runs** lists every workflow run: id, workflow (linked), created, started,
duration, state. Filter by state chip (`all`, `running`, `queued`, `paused`,
`waiting_for_human`, `recovery_required`, `succeeded`, `failed`, `cancelled`)
and window (25/100/500).

### Detail

Opening a run shows, in order:

- A **recovery panel** (only when relevant): interrupted nodes, their job,
  attempt count, and whether a callback is still pending on the worker side.
- **Run control**: **Pause**, **Resume**, or — for `recovery_required` —
  **Authorize retry & resume** (confirmation explicitly warns Atlas submits a
  **new** job per incomplete node rather than reattaching to the old one).
  **Cancel** has its own confirmation. Every confirmation's dismiss button
  reads **Leave it alone**.
- The **run graph**: a read-only canvas of the frozen graph snapshot (not the
  live editable definition). A "start" badge marks the entry node; each
  node's border color reflects its runtime state (running/waiting/succeeded/
  failed or interrupted/skipped); matched edges (the path Atlas actually
  took) draw thicker and in the accent color.
- **Live job events**: inline, only for jobs behind currently-running nodes.
  Phases are shown literally: connecting, streaming, stale, reconnecting
  (with attempt count and backoff), closed, or — on failure — disconnected,
  session expired, access denied, job not found. Up to 4 concurrent streams;
  the visible log is capped with a note on how much is buffered above it.
- A **Runtime nodes** table (node, job, attempt, duration, error, state) and
  a **Runtime edges** table (from, to, whether the condition matched).
- **Approvals**: one row per gate reached, with **Approve** (or one button
  per choice) and a **Reject** confirmation ("Reject this gate and fail the
  run?" / **Reject and fail the run**). A decided gate shows its timestamp;
  gates are undecidable a second time. There is no separate "manager
  decisions" panel — a manager node's outcome shows up like any other node in
  Runtime nodes/the canvas, labeled **AI Decision**.
- **Artifacts**: key, kind, size, created, and a **Download** or **Preview**
  action (never both — `file_ref` artifacts download, everything else
  previews in a dialog capped at the first 32,000 characters). **There is no
  upload control here** — attaching a file to a run (e.g. a contract for a
  human gate) is API-only (`POST /api/workflow-runs/{id}/files`).
- **Webhook delivery attempts** for this run, with a **Send webhook now**
  button and a **Retry webhook** button on `failed`/`blocked` rows (see §11
  for the full Deliveries page).
- **Run events**: a paginated table (seq, at, event, node, payload) with
  **Load more events** for older history.

## 10. Triggers

**Triggers** is a table (not cards): Trigger (name/type/id), Starts (linked
workflow), Configuration (a summary; webhook rows also show the exact
`POST /api/workflow-triggers/{id}/fire` path with a copy button), Fired
(last/next), Last event (a single status pill plus error, if any — there is
no expandable event-history list, unlike Atlas's own trigger cards), Enabled
(switch), and row actions: Fire, Edit, Delete.

The six trigger types are unchanged from Atlas's API: `manual`, `schedule`,
`webhook`, `workflow_run_completed`, `artifact_created`,
`worker_status_changed`. **New trigger** / **Edit trigger** is fully
form-driven — there is no raw Config-JSON textarea:

| Type                     | Fields                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `schedule`               | **Every N minutes** or **Once a day at** (Atlas's host clock is called out explicitly, not the browser's)                                  |
| `workflow_run_completed` | **Source workflow** ("Any workflow"), **Run state** ("Any state" / succeeded / failed / cancelled)                                         |
| `artifact_created`       | **Source workflow**, **Artifact key** ("Any key"), **Artifact kind** ("Any kind" / text / json / markdown / file_ref / summary / decision) |
| `worker_status_changed`  | **Worker** ("Any worker"), **New status** ("Any status" / online / offline)                                                                |
| `webhook`                | none — shows the fixed fire path instead                                                                                                   |
| `manual`                 | none — fires only from the Fire button or a direct API call                                                                                |

Deleting a trigger warns that it deletes the trigger's whole fire history too
(runs it already started are kept). There is no Suggest-triggers helper.

## 11. Webhook Deliveries

**Webhook Deliveries** lists outbound callback attempts Atlas made after a
workflow run finished: Delivery ID, Run (linked), Target URL, Attempts
(`n/max`), Last error, Status. The four statuses are `pending`, `delivered`,
`failed`, `blocked`. Filter by status chip or by run id ("Filter by run id
(applied by Atlas)"). **Retry webhook** is offered only on `failed`/`blocked`
rows, and only to `admin`/`operator` (Atlas still enforces this server-side
regardless of what the button shows).

## 12. Artifacts

**Artifacts** is the cross-run ledger backed by Atlas's `GET /api/artifacts`
— every run's artifacts in one newest-first list, metadata-only (no artifact
content is ever inlined in the list itself). Filter by kind chip (`text`,
`json`, `markdown`, `file_ref`, `summary`, `decision`), by run id, job id, or
key, and choose a window (25/100/500). Columns: Key, Kind, Produced by
(links to the run, or shows the job id), Size, Created, and a **Download** or
**Preview** action exactly like the per-run Artifacts panel (§9).

The footer is explicit that this list is a window over the total, while a
single run's own Artifacts panel (§9) is always the complete, untruncated set
for that run.

## 13. Usage & Metering

**Usage & Metering** reads Atlas's append-only usage ledger. Pick **From**/
**To** (inclusive) or leave both blank for the last 30 days — Atlas places no
limit on this endpoint, so an unbounded request would return the entire
ledger, and the page says so explicitly.

Four tiles: **Workflow runs** (plus how many succeeded), **Jobs** (plus job
wall time), **Budget units** (plus run wall time), **Tokens** (prompt/
output, worker-reported). Below them, an estimated-cost line is explicit that
this is "a per-event visibility estimate Atlas froze at write time, not a
billable charge" — Atlas meters usage; it does not price, invoice, or
enforce quotas. **There is no chart and no quota/threshold alert on this
page** — contrast with Atlas's own Usage view, which has both.

An events table (kind, status, units, tokens, est. cost, run/job, actor) is
capped at 200 visible rows even when more match; **Export CSV** always
contains the full range.

## 14. Audit Log

**Audit Log** renders as a monospace log, not a table: timestamp, `[actor]`,
action, `→ resource`, and detail — not a structured column layout. Filter by
window (25/100/500) and by date range; **there is no filter by action type**
(job/workflow/worker/approval) and **rows are not clickable** — both are
things Atlas's own Audit view added instead (see that guide, §6). **Export
CSV** covers the full filtered range.

## 15. Users & Tokens

Admin-only; other roles see a forbidden state. **Create user** takes
**Username**, **Password**, **Role** (`admin`, `operator`, `viewer`,
`auditor`), and **Status** (`active`, `disabled`) — there is no separate
"suspend" button, just this status field.

Unlike Atlas's own console, editing or deleting your own account is **never
hard-disabled** here — it's warned instead ("This is your own account:
demoting or disabling it takes effect on your next request and can lock you
out of this page" / "...deleting it revokes the session you are using right
now").

**API tokens**: **Mint token** takes **User**, **Token name**, and an
optional **Expiry** (UTC). The minted value is shown exactly once — "Atlas
stores only a hash, so this value cannot be shown again — not after closing
this dialog, not after a reload" — with a **Copy** button and a **Done —
discard the value** close action. Tokens can be renamed or revoked
afterward; revoking one currently backing a live session signs that session
out on its next request.

## 16. Settings

**Settings** is intentionally almost empty: three read-only rows (Atlas
version, schema version, server time) sourced from `GET /api/metrics`, plus a
short note explaining that Atlas has no authenticated settings API, so there
is nothing else to configure here — not a theme toggle, not a profile
editor. (An earlier revision of this page showed fabricated hostname/TLS/
integration details; those were removed as invented.) flow-designer has no
light/dark theme toggle anywhere, unlike Atlas's own console.

## 17. Troubleshooting

| Symptom                                                               | Check                                                                                                                                                                         |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stuck on "Signing in" or repeated rate-limit message                  | Wait out the countdown shown; Atlas rate-limits login attempts                                                                                                                |
| Session-expiry banner appears mid-task                                | Save your work; sign in again once it lapses — the 5-session cap can also have evicted this session from another sign-in                                                      |
| "Atlas is not responding" banner                                      | Atlas is unreachable; retry the affected panel once it recovers rather than trusting the cached numbers on screen                                                             |
| A page shows a forbidden state                                        | The signed-in user's Atlas role does not permit it — Users & Tokens, for instance, is admin-only                                                                              |
| Workflow won't Run                                                    | Fix every item in the editor's live Checks list first, then **Save**, then **Run**                                                                                            |
| Need to pass run input (`{input.x}`)                                  | Not available from the editor's Run button; start the run through `POST /api/workflow-runs` with an `input` object                                                            |
| Need to attach a file to a run, or submit an ad-hoc job               | Both are API-only today; see [API Reference](https://github.com/kaebmoo/atlas-control-plane/blob/main/docs/specs/api-reference-en.md)                                         |
| Need deep per-job debugging (tool calls, raw events, collected files) | Use [Atlas's own console](https://github.com/kaebmoo/atlas-control-plane/blob/main/docs/guides/web-user-guide-en.md#4-jobs-output-and-events) instead of this app's Jobs page |

For the underlying Atlas concepts (node types, join modes, conditions,
artifact kinds, policy fields, trigger types) see
[Concepts & Reference](https://github.com/kaebmoo/atlas-control-plane/blob/main/docs/concepts-en.md).
For the full API surface, see the
[API Reference](https://github.com/kaebmoo/atlas-control-plane/blob/main/docs/specs/api-reference-en.md).
