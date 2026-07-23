import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { ADMIN_CREDENTIALS, VIEWER_CREDENTIALS } from "../contract/atlas-instance";
import { readSeed } from "./global-setup";

/**
 * Browser acceptance for the Phase 5 operational pages.
 *
 * Everything asserted here is real Atlas state: `globalSetup` boots an isolated Atlas, the
 * dev server talks only to it, and where a spec needs a fixture the shared seed cannot
 * provide (a delivery row), it creates one through Atlas's own API with the seed's admin
 * bearer. The retryable preview spec aborts the browser-to-app RPC to exercise transport
 * handling; Atlas responses themselves are never stubbed.
 */

let cachedSeed: ReturnType<typeof readSeed> | undefined;
function seed() {
  cachedSeed ??= readSeed();
  return cachedSeed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function actionName(action: "Download" | "Preview", key: string): RegExp {
  return new RegExp(`^${action} ${escapeRegExp(key)} \\(`);
}

async function signIn(page: Page, creds: typeof ADMIN_CREDENTIALS) {
  await page.goto("/auth");
  await page.locator('form[data-hydrated="true"]').waitFor({ state: "attached" });
  await page.getByLabel("Username").fill(creds.username);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

/**
 * Navigates and waits for React to own the page before any interaction.
 *
 * Every page is server-rendered, so buttons exist and are clickable before hydration — and a
 * click in that window does nothing. The app shell publishes `data-hydrated` for exactly this.
 */
async function gotoHydrated(page: Page, path: string) {
  await page.goto(path);
  await page.locator('div[data-hydrated="true"]').first().waitFor({ state: "attached" });
}

/** POST to the isolated Atlas directly, as the seeded admin — for spec-local fixtures. */
async function atlasPost(path: string, body: unknown): Promise<Record<string, unknown>> {
  const { atlasOrigin, adminToken } = seed();
  const response = await fetch(`${atlasOrigin}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

/** Upload one real `file_ref` artifact through Atlas's bounded raw-byte route. */
async function atlasUpload(
  runId: string,
  key: string,
  filename: string,
  content: string,
): Promise<Record<string, unknown>> {
  const { atlasOrigin, adminToken } = seed();
  const body = Buffer.from(content);
  const response = await fetch(
    `${atlasOrigin}/api/workflow-runs/${encodeURIComponent(runId)}/files?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "text/plain",
        "content-length": String(body.length),
        "x-filename": filename,
      },
      body,
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`artifact upload failed: ${response.status} ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function atlasGet(path: string): Promise<Record<string, unknown>> {
  const { atlasOrigin, adminToken } = seed();
  const response = await fetch(`${atlasOrigin}${path}`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

function insertStandaloneFileArtifact({
  key,
  relpath,
  content,
}: {
  key: string;
  relpath: string;
  content: string;
}): { artifactId: string; filename: string } {
  const { atlasRestart, jobId } = seed();
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const artifactId = `art_e2e_${suffix}`;
  const uploadId = `file_e2e_${suffix}`;
  const bytes = Buffer.from(content);
  const metadata = JSON.stringify({
    relpath,
    media_type: "text/plain",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    source_job_id: jobId,
  });
  const now = new Date().toISOString();
  mkdirSync(atlasRestart.uploadDir, { recursive: true });
  writeFileSync(join(atlasRestart.uploadDir, uploadId), bytes);

  const result = spawnSync(
    "python3",
    [
      "-c",
      `
import sqlite3
import sys

db_path, artifact_id, job_id, key, upload_id, metadata, now = sys.argv[1:]
with sqlite3.connect(db_path) as conn:
    conn.execute(
        """
        INSERT INTO artifacts(id, run_id, job_id, key, kind, content, metadata, created_at, updated_at)
        VALUES (?, NULL, ?, ?, 'file_ref', ?, ?, ?, ?)
        """,
        (artifact_id, job_id, key, upload_id, metadata, now, now),
    )
`,
      atlasRestart.dbPath,
      artifactId,
      jobId,
      key,
      uploadId,
      metadata,
      now,
    ],
    { encoding: "utf-8" },
  );
  if (result.status !== 0) {
    throw new Error(`standalone artifact insert failed: ${result.stderr || result.stdout}`);
  }

  const filename = relpath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? key;
  return { artifactId, filename };
}

/**
 * Creates a run with a reply callback, waits for it to fail, opens one delivery, and walks it
 * to `failed` through Atlas's own bounded retries — the state the UI offers a manual retry on.
 */
async function createFailedDeliveryFixture(): Promise<{ deliveryId: string; runId: string }> {
  const started = await atlasPost("/api/workflow-runs", {
    workflow_definition_id: seed().workflowId,
    input: { _meta: { reply: { mode: "none", callback_url: "http://127.0.0.1:9/e2e-hook" } } },
  });
  const runId = (started.run as { id: string }).id;

  const deadline = Date.now() + 20_000;
  for (;;) {
    const detail = await atlasGet(`/api/workflow-runs/${runId}`);
    const state = (detail.run as { state: string }).state;
    if (state === "failed" || state === "succeeded") break;
    if (Date.now() > deadline) throw new Error(`run ${runId} never became terminal`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const delivered = await atlasPost(`/api/workflow-runs/${runId}/deliver`, {});
  let delivery = delivered.delivery as { id: string; status: string };
  for (let index = 0; index < 8 && delivery.status !== "failed"; index += 1) {
    const retried = await atlasPost(`/api/deliveries/${delivery.id}/retry`, {});
    delivery = retried.delivery as { id: string; status: string };
  }
  if (delivery.status !== "failed") throw new Error("delivery never reached failed");
  return { deliveryId: delivery.id, runId };
}

test.describe("Phase 5: role-restricted pages for a viewer", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, VIEWER_CREDENTIALS);
  });

  test("deliveries, audit, usage, and users all render an explicit forbidden state", async ({
    page,
  }) => {
    // Deliveries: viewer holds no deliveries.read.
    await page.goto("/deliveries");
    await expect(page.getByText("Not allowed")).toBeVisible();
    await expect(page.getByText("dlv_5501")).toHaveCount(0);

    // Audit: audit.read is admin/auditor only.
    await page.goto("/audit");
    await expect(page.getByText("Not allowed")).toBeVisible();
    await expect(page.getByText("operator_01")).toHaveCount(0);

    // Usage: same permission as audit.
    await page.goto("/usage");
    await expect(page.getByText("Not allowed")).toBeVisible();
    await expect(page.getByText("Research · GPU-01")).toHaveCount(0);

    // Users: admin only, with copy that names the requirement.
    await page.goto("/users");
    await expect(page.getByText(/requires the Atlas admin role/)).toBeVisible();
    await expect(page.getByText("op1@atlas.dev")).toHaveCount(0);
  });

  test("a viewer can read conversations but is offered no create action", async ({ page }) => {
    await page.goto("/conversations");
    // The page loads real data (or a real empty state) — never the scaffold's rows.
    await expect(page.getByText(/most recently updated conversations/)).toBeVisible();
    await expect(page.getByText("conv_1204")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New conversation" })).toHaveCount(0);
  });

  test("the CSV export routes refuse a viewer with Atlas's 403", async ({ page }) => {
    const audit = await page.request.get("/api/exports/audit-csv?limit=25");
    expect(audit.status()).toBe(403);
    const usage = await page.request.get("/api/exports/usage-csv");
    expect(usage.status()).toBe(403);
  });
});

test.describe("Phase 5: operational pages as admin", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, ADMIN_CREDENTIALS);
  });

  test("a created conversation comes back from Atlas after a full reload", async ({ page }) => {
    const title = `E2E conversation ${Date.now()}`;
    await gotoHydrated(page, "/conversations");
    await page.getByRole("button", { name: "New conversation" }).click();
    await page.getByLabel("Title").fill(title);
    await page.getByRole("button", { name: "Create conversation" }).click();

    // The dialog closes on Atlas's 201 and the invalidated list refetches.
    await expect(page.getByRole("cell", { name: title })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("cell", { name: title })).toBeVisible();
  });

  test("artifacts renders real rows, filters, lazy preview, empty state, totals, and download", async ({
    page,
  }) => {
    const suffix = Date.now();
    const previewKey = `ledger_preview_${suffix}`;
    const previewContent = `On-demand preview ${suffix}`;
    const fileKey = `ledger_file_${suffix}`;
    const fileContent = `Downloaded from the artifact ledger ${suffix}\n`;
    const filename = `phase5-ledger-${suffix}.txt`;

    await atlasPost("/api/artifacts", {
      run_id: seed().runId,
      key: previewKey,
      kind: "text",
      content: previewContent,
    });
    await atlasUpload(seed().runId, fileKey, filename, fileContent);

    await gotoHydrated(page, "/artifacts");

    // Inline content is absent from the ledger DOM until the row's own preview action asks
    // Atlas for that one artifact by id.
    const previewRow = page.getByRole("row").filter({ hasText: previewKey });
    await expect(previewRow).toBeVisible();
    await expect(page.getByText(previewContent)).toHaveCount(0);
    const previewButton = previewRow.getByRole("button", {
      name: actionName("Preview", previewKey),
    });
    await previewButton.click();
    await expect(page.getByRole("dialog", { name: `Preview ${previewKey}` })).toBeVisible();
    await expect(page.getByTestId("artifact-preview")).toHaveText(previewContent);
    await page.getByRole("button", { name: "Close" }).click();
    await expect(previewButton).toBeFocused();

    await previewButton.click();
    await expect(page.getByRole("dialog", { name: `Preview ${previewKey}` })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: `Preview ${previewKey}` })).toHaveCount(0);
    await expect(previewButton).toBeFocused();

    await previewButton.click();
    await expect(page.getByRole("dialog", { name: `Preview ${previewKey}` })).toBeVisible();
    await page.mouse.click(10, 10);
    await expect(page.getByRole("dialog", { name: `Preview ${previewKey}` })).toHaveCount(0);
    await expect(previewButton).toBeFocused();

    // The run filter is pushed into the URL and Atlas reports a truthful filtered total.
    await page.getByLabel(/Filter by run id/).fill(seed().runId);
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page).toHaveURL(new RegExp(`[?&]run=${seed().runId}(?:&|$)`));
    await expect(page.getByRole("row").filter({ hasText: previewKey })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: fileKey })).toBeVisible();
    await expect(
      page.getByText(/Showing the 2 newest of the 2 artifacts Atlas holds/),
    ).toBeVisible();

    await page.getByLabel(/Filter by artifact key/).fill(previewKey);
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page).toHaveURL(new RegExp(`[?&]key=${previewKey}(?:&|$)`));
    await expect(page.getByRole("row").filter({ hasText: previewKey })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: fileKey })).toHaveCount(0);
    await expect(
      page.getByText(/Showing the 1 newest of the 1 artifact Atlas holds/),
    ).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`[?&]run=${seed().runId}(?:&|$)`));
    await expect(page.getByRole("row").filter({ hasText: fileKey })).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`[?&]key=${previewKey}(?:&|$)`));

    // Kind filtering changes both the URL and rows without lying about the total.
    await page.getByRole("button", { name: "text", exact: true }).click();
    await expect(page).toHaveURL(/(?:\?|&)kind=text(?:&|$)/);
    await expect(page.getByRole("row").filter({ hasText: previewKey })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: fileKey })).toHaveCount(0);
    await expect(
      page.getByText(/Showing the 1 newest of the 1 artifact Atlas holds/),
    ).toBeVisible();

    // A real zero-row Atlas answer renders the filtered empty state.
    await page.getByRole("button", { name: "decision", exact: true }).click();
    await expect(page.getByText("Atlas has no artifacts matching these filters.")).toBeVisible();

    // `file_ref` downloads travel through the authenticated same-origin proxy.
    await gotoHydrated(
      page,
      `/artifacts?run=${encodeURIComponent(seed().runId)}&key=${encodeURIComponent(fileKey)}&kind=file_ref`,
    );
    const fileRow = page.getByRole("row").filter({ hasText: fileKey });
    await expect(fileRow.getByRole("button", { name: actionName("Preview", fileKey) })).toHaveCount(
      0,
    );
    const downloadPromise = page.waitForEvent("download");
    await fileRow.getByRole("button", { name: actionName("Download", fileKey) }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(filename);
    const stream = await download.createReadStream();
    if (!stream) throw new Error("Playwright did not expose the artifact download stream");
    let downloaded = "";
    for await (const chunk of stream) downloaded += chunk.toString();
    expect(downloaded).toBe(fileContent);

    // The original mock ledger never reappears.
    await expect(page.getByText("art_9210")).toHaveCount(0);
    await expect(page.getByText("analysis_report.pdf")).toHaveCount(0);
  });

  test("artifact preview truncates on a Unicode-safe boundary", async ({ page }) => {
    const suffix = Date.now();
    const unicodeKey = `unicode_preview_${suffix}`;
    const previewPrefix = `${"a".repeat(31_998)}😀`;
    const hiddenTail = "TAIL_AFTER_BOUNDARY";

    await atlasPost("/api/artifacts", {
      run_id: seed().runId,
      key: unicodeKey,
      kind: "text",
      content: `${previewPrefix}${hiddenTail}`,
    });

    await gotoHydrated(
      page,
      `/artifacts?run=${encodeURIComponent(seed().runId)}&key=${encodeURIComponent(unicodeKey)}`,
    );
    const row = page.getByRole("row").filter({ hasText: unicodeKey });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: actionName("Preview", unicodeKey) }).click();
    await expect(page.getByText("Preview limited to the first 32,000 characters.")).toBeVisible();
    const previewText = await page.getByTestId("artifact-preview").textContent();
    expect(previewText).toBe(previewPrefix);
    expect(previewText).toContain("😀");
    expect(previewText).not.toContain(hiddenTail);
  });

  test("run detail previews an inline artifact older than the global window", async ({ page }) => {
    const suffix = Date.now();
    const oldKey = `run_detail_old_preview_${suffix}`;
    const oldContent = `Run detail preview remains available ${suffix}`;

    await atlasPost("/api/artifacts", {
      run_id: seed().runId,
      key: oldKey,
      kind: "text",
      content: oldContent,
    });
    for (let index = 0; index < 26; index += 1) {
      await atlasPost("/api/artifacts", {
        run_id: seed().runId,
        key: `run_detail_newer_${suffix}_${index}`,
        kind: "text",
        content: `newer ${index}`,
      });
    }

    await gotoHydrated(page, `/artifacts?limit=25&run=${encodeURIComponent(seed().runId)}`);
    await expect(page.getByRole("row").filter({ hasText: oldKey })).toHaveCount(0);

    await gotoHydrated(page, `/runs/${encodeURIComponent(seed().runId)}`);
    const row = page.getByRole("row").filter({ hasText: oldKey });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: actionName("Preview", oldKey) }).click();
    await expect(page.getByRole("dialog", { name: `Preview ${oldKey}` })).toBeVisible();
    await expect(page.getByTestId("artifact-preview")).toHaveText(oldContent);
  });

  test("preview shows Retry only for a retryable transport error", async ({ page }) => {
    const suffix = Date.now();
    const retryKey = `retryable_preview_${suffix}`;
    const retryContent = `Preview recovers after retry ${suffix}`;

    await atlasPost("/api/artifacts", {
      run_id: seed().runId,
      key: retryKey,
      kind: "text",
      content: retryContent,
    });

    await gotoHydrated(
      page,
      `/artifacts?run=${encodeURIComponent(seed().runId)}&key=${encodeURIComponent(retryKey)}`,
    );
    const row = page.getByRole("row").filter({ hasText: retryKey });
    await expect(row).toBeVisible();

    await page.route("**/_serverFn/**", (route) => route.abort("failed"));
    await row.getByRole("button", { name: actionName("Preview", retryKey) }).click();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible({ timeout: 30_000 });
    await page.unroute("**/_serverFn/**");

    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId("artifact-preview")).toHaveText(retryContent, {
      timeout: 30_000,
    });
  });

  test("preview redirects on an expired session without offering Retry", async ({
    page,
    context,
  }) => {
    const suffix = Date.now();
    const unauthorizedKey = `unauthorized_preview_${suffix}`;

    await atlasPost("/api/artifacts", {
      run_id: seed().runId,
      key: unauthorizedKey,
      kind: "text",
      content: `This should require a fresh session ${suffix}`,
    });

    await gotoHydrated(
      page,
      `/artifacts?run=${encodeURIComponent(seed().runId)}&key=${encodeURIComponent(unauthorizedKey)}`,
    );
    const row = page.getByRole("row").filter({ hasText: unauthorizedKey });
    await expect(row).toBeVisible();
    await context.clearCookies();
    await row.getByRole("button", { name: actionName("Preview", unauthorizedKey) }).click();
    await expect(page).toHaveURL(/\/auth$/);
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  });

  test("standalone job file_ref downloads use relpath basename when filename is absent", async ({
    page,
  }) => {
    const suffix = Date.now();
    const fileKey = `standalone_file_${suffix}`;
    const fileContent = `Standalone job file ${suffix}\n`;
    const { filename } = insertStandaloneFileArtifact({
      key: fileKey,
      relpath: `reports/${suffix}/standalone-final.txt`,
      content: fileContent,
    });

    await gotoHydrated(
      page,
      `/artifacts?job=${encodeURIComponent(seed().jobId)}&key=${encodeURIComponent(fileKey)}&kind=file_ref`,
    );
    const row = page.getByRole("row").filter({ hasText: fileKey });
    await expect(row).toBeVisible();
    await expect(row.getByText(`job ${seed().jobId}`)).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await row.getByRole("button", { name: actionName("Download", fileKey) }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(filename);
    const stream = await download.createReadStream();
    if (!stream) throw new Error("Playwright did not expose the artifact download stream");
    let downloaded = "";
    for await (const chunk of stream) downloaded += chunk.toString();
    expect(downloaded).toBe(fileContent);
  });

  test("deliveries shows real rows, pushes filters to Atlas, and retries reflect Atlas state", async ({
    page,
  }) => {
    const fixture = await createFailedDeliveryFixture();

    await gotoHydrated(page, "/deliveries");
    const row = page.getByRole("row").filter({ hasText: fixture.deliveryId });
    await expect(row).toBeVisible();
    await expect(row.getByText("failed")).toBeVisible();
    await expect(row.getByText("5/5")).toBeVisible();

    // The failed chip is a server-side filter (status=failed) — the row stays.
    await page.getByRole("button", { name: "failed", exact: true }).click();
    await expect(page.getByRole("row").filter({ hasText: fixture.deliveryId })).toBeVisible();

    // Delivered: a real Atlas answer with zero rows, stated as such.
    await page.getByRole("button", { name: "delivered", exact: true }).click();
    await expect(
      page.getByText("Atlas has no webhook deliveries matching these filters."),
    ).toBeVisible();

    // Back to failed; the UI retry makes one more real bounded attempt against the dead
    // target, so Atlas's row advances to attempts 6/5 and the invalidated query shows it.
    await page.getByRole("button", { name: "failed", exact: true }).click();
    const retryRow = page.getByRole("row").filter({ hasText: fixture.deliveryId });
    await retryRow.getByRole("button", { name: "Retry webhook" }).click();
    await expect(retryRow.getByText("6/5")).toBeVisible();

    // The run_id filter is also Atlas-side.
    await page.getByRole("button", { name: "all", exact: true }).click();
    await page.getByLabel(/Filter by run id/).fill(fixture.runId);
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByRole("row").filter({ hasText: fixture.deliveryId })).toBeVisible();

    // Backing out of the run filter must re-seed the draft input: a form still showing the
    // run id above an unfiltered table would misreport what the table contains.
    await page.goBack();
    await expect(page.getByLabel(/Filter by run id/)).toHaveValue("");
    await expect(page.getByRole("row").filter({ hasText: fixture.deliveryId })).toBeVisible();

    // No scaffold rows anywhere.
    await expect(page.getByText("dlv_5501")).toHaveCount(0);
  });

  test("audit shows real entries, a date range changes the result, and CSV downloads", async ({
    page,
  }) => {
    await gotoHydrated(page, "/audit");
    // Seeding and sign-ins wrote real audit rows; auth.login is guaranteed by this session.
    await expect(page.getByText("auth.login").first()).toBeVisible();
    await expect(page.getByText(/newest entries/)).toBeVisible();

    // A 1990 range, applied by Atlas, returns nothing — and says so.
    await page.getByLabel("From (inclusive)").fill("1990-01-01");
    await page.getByLabel("To (inclusive)").fill("1990-01-02");
    await page.getByRole("button", { name: "Apply range" }).click();
    await expect(
      page.getByText("Atlas recorded no audit entries in this date range."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Clear" }).click();
    await expect(page.getByText("auth.login").first()).toBeVisible();

    // The export is a same-origin authenticated download; the response is Atlas's CSV.
    const response = await page.request.get("/api/exports/audit-csv?limit=25");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/csv");
    expect(response.headers()["content-disposition"]).toContain("atlas-audit.csv");
    expect(await response.text()).toMatch(/^id,created_at,actor,action/);

    // The scaffold's fabricated log lines are gone.
    await expect(page.getByText("operator_01")).toHaveCount(0);
    await expect(page.getByText("wf_ingest")).toHaveCount(0);
  });

  test("browser Back/Forward keeps the audit range form in sync with the data", async ({
    page,
  }) => {
    await gotoHydrated(page, "/audit");
    await expect(page.getByText("auth.login").first()).toBeVisible();

    await page.getByLabel("From (inclusive)").fill("1990-01-01");
    await page.getByLabel("To (inclusive)").fill("1990-01-02");
    await page.getByRole("button", { name: "Apply range" }).click();
    await expect(
      page.getByText("Atlas recorded no audit entries in this date range."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Clear" }).click();
    await expect(page.getByText("auth.login").first()).toBeVisible();
    await expect(page.getByLabel("From (inclusive)")).toHaveValue("");

    // Back to the 1990 range: the table AND the inputs must both describe it.
    await page.goBack();
    await expect(
      page.getByText("Atlas recorded no audit entries in this date range."),
    ).toBeVisible();
    await expect(page.getByLabel("From (inclusive)")).toHaveValue("1990-01-01");
    await expect(page.getByLabel("To (inclusive)")).toHaveValue("1990-01-02");

    // Back again to the unbounded view: inputs empty, entries back.
    await page.goBack();
    await expect(page.getByText("auth.login").first()).toBeVisible();
    await expect(page.getByLabel("From (inclusive)")).toHaveValue("");
  });

  test("usage shows Atlas totals labelled as estimates, and CSV downloads", async ({ page }) => {
    await gotoHydrated(page, "/usage");
    await expect(page.getByText("Workflow runs", { exact: true })).toBeVisible();
    await expect(page.getByText(/not a billable\s+charge/)).toBeVisible();

    // A bare visit is bounded by default — the endpoint has no limit, so the page must never
    // request the entire ledger implicitly. The note and the pre-seeded input say so.
    await expect(page.getByText(/Defaulting to the last 30 days/)).toBeVisible();
    await expect(page.getByLabel("From (inclusive)")).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
    const defaultFrom = await page.getByLabel("From (inclusive)").inputValue();

    /**
     * The note alone could lie — prove the *request* carries the default bound. The usage
     * server function is a GET whose payload rides the query string (TanStack serialises the
     * data structurally, keys and values in separate arrays, so the quoted date — not a
     * `"from":` pair — is what appears). The target function is named in the base64 route id.
     * (Atlas honouring `from` is contract-proven; an event older than the window cannot be
     * seeded here because Atlas writes usage rows internally with its own timestamps and
     * exposes no usage-write endpoint.)
     */
    const [rpcRequest] = await Promise.all([
      page.waitForRequest(
        (request) =>
          request.url().includes("/_serverFn/") &&
          decodeURIComponent(request.url()).includes(`"${defaultFrom}"`),
      ),
      page.reload(),
    ]);
    const rpcId = Buffer.from(
      new URL(rpcRequest.url()).pathname.split("/_serverFn/")[1] ?? "",
      "base64",
    ).toString();
    expect(rpcId).toContain("getUsageFn");
    await expect(page.getByText(/Defaulting to the last 30 days/)).toBeVisible();

    // Real usage rows exist (the seeded run and job both failed, which meters them).
    await expect(
      page.getByText(/events? in this range|newest 200|Atlas has recorded no usage/),
    ).toBeVisible();

    // The export link carries the same default bound, and the download honours it.
    const exportLink = page.getByRole("link", { name: /Export CSV/ });
    await expect(exportLink).toHaveAttribute("href", new RegExp(`from=${defaultFrom}`));
    const exportHref = (await exportLink.getAttribute("href"))!;
    const response = await page.request.get(exportHref);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/csv");
    expect(await response.text()).toMatch(/^id,idempotency_key,kind/);

    // A 1990 range zeroes the totals through Atlas, not through client filtering.
    await page.getByLabel("From (inclusive)").fill("1990-01-01");
    await page.getByLabel("To (inclusive)").fill("1990-01-02");
    await page.getByRole("button", { name: "Apply range" }).click();
    await expect(
      page.getByText("Atlas recorded no usage events in this date range."),
    ).toBeVisible();

    // The scaffold's invented per-worker cost table is gone.
    await expect(page.getByText("Research · GPU-01")).toHaveCount(0);
    await expect(page.getByText("$2.12")).toHaveCount(0);
  });

  test("users: create, edit, mint a one-time token, revoke, and delete — all against Atlas", async ({
    page,
  }) => {
    const username = `e2e-user-${Date.now()}`;
    await gotoHydrated(page, "/users");

    // Real users from Atlas, no scaffold rows, and the action is Create — not Invite.
    await expect(page.getByRole("cell", { name: "admin", exact: false }).first()).toBeVisible();
    await expect(page.getByText("op1@atlas.dev")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Invite/ })).toHaveCount(0);

    // Login metadata identifies the real browser session by immutable token id, never by name.
    const currentSession = page.getByTestId("current-session-token");
    await expect(currentSession).toHaveText("current session");
    const currentSessionRow = currentSession.locator("xpath=ancestor::tr");
    await expect(currentSessionRow).toContainText("session");
    await expect(currentSessionRow.getByText("never", { exact: true })).toHaveCount(0);

    // Create.
    await page.getByRole("button", { name: "Create user" }).click();
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill("e2e-password-1");
    await page.getByLabel("Role").selectOption("viewer");
    await page.getByRole("button", { name: "Create user" }).last().click();
    const userRow = page.getByRole("row").filter({ hasText: username });
    await expect(userRow).toBeVisible();

    // Edit: promote to auditor; the row reflects Atlas's answer after invalidation.
    await userRow.getByRole("button", { name: `Edit ${username}` }).click();
    await page.getByLabel("Role").selectOption("auditor");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(userRow.getByText("Auditor")).toBeVisible();

    // Mint a token for that user; the raw value appears exactly once.
    await page.getByRole("button", { name: "Mint token" }).click();
    await page.getByLabel("User", { exact: true }).selectOption({ label: `${username} (Auditor)` });
    await page.getByLabel("Token name").fill("e2e token");
    await page.getByLabel("Expiry (optional)").fill("2030-01-02T03:04");
    await page.getByRole("button", { name: "Mint token" }).last().click();
    const tokenValue = (await page.getByTestId("minted-token").textContent()) ?? "";
    expect(tokenValue.length).toBeGreaterThan(10);
    await expect(page.getByText(/cannot be shown again/)).toBeVisible();

    // Closing the dialog discards the value; it exists nowhere in the page or its storage.
    await page.getByRole("button", { name: "Done — discard the value" }).click();
    await expect(page.getByText(tokenValue)).toHaveCount(0);
    const storages = await page.evaluate(() => [
      JSON.stringify(localStorage),
      JSON.stringify(sessionStorage),
    ]);
    for (const storage of storages) expect(storage).not.toContain(tokenValue);

    // A reload cannot bring it back — Atlas holds only a hash.
    await page.reload();
    await expect(page.getByText(tokenValue)).toHaveCount(0);

    // The metadata row exists and can be revoked.
    const tokenRow = page.getByRole("row").filter({ hasText: "e2e token" });
    await expect(tokenRow).toBeVisible();
    await expect(tokenRow.getByText(/2030-01-/)).toBeVisible();
    await expect(tokenRow.getByText("never", { exact: true })).toHaveCount(0);
    await tokenRow.getByRole("button", { name: /Revoke token/ }).click();
    await page.getByRole("button", { name: "Revoke token" }).last().click();
    await expect(tokenRow.getByText("revoked")).toBeVisible();

    // Delete the user, which Atlas cascades to their tokens; the confirmation says so.
    await userRow.getByRole("button", { name: `Delete ${username}` }).click();
    await expect(page.getByText(/deletes the user and every API token/i)).toBeVisible();
    await page.getByRole("button", { name: "Delete user" }).click();
    await expect(page.getByRole("row").filter({ hasText: username })).toHaveCount(0);
  });

  test("settings shows only real Atlas values, read-only", async ({ page }) => {
    await gotoHydrated(page, "/settings");
    await expect(page.getByText("Atlas version")).toBeVisible();
    await expect(page.getByText("Schema version")).toBeVisible();
    await expect(page.getByText(/read-only, from GET \/api\/metrics/)).toBeVisible();
    await expect(page.getByText(/no settings API/i).first()).toBeVisible();

    // The fabricated instance facts and danger zone are gone.
    await expect(page.getByText("atlas.prod.eu-west-1")).toHaveCount(0);
    await expect(page.getByText("Danger zone")).toHaveCount(0);
    await expect(page.getByText("Let's Encrypt")).toHaveCount(0);
    await expect(page.getByText("s3://atlas-artifacts")).toHaveCount(0);
  });

  test("no Phase 5 page regresses to scaffold data after refetch and reload", async ({ page }) => {
    // Strings that only ever existed in the deleted mock arrays, swept across every page.
    const mockStrings = [
      "conv_1204",
      "dlv_5501",
      "art_9210",
      "op1@atlas.dev",
      "tok_a1",
      "atlas.prod.eu-west-1",
    ];
    for (const path of [
      "/conversations",
      "/artifacts",
      "/deliveries",
      "/usage",
      "/audit",
      "/users",
      "/settings",
    ]) {
      await page.goto(path);
      await page.reload();
      const content = await page.content();
      for (const needle of mockStrings) {
        expect(content, `${path} still contains ${needle}`).not.toContain(needle);
      }
    }
  });
});
