import { expect, test, type Page } from "@playwright/test";

import { ADMIN_CREDENTIALS, VIEWER_CREDENTIALS } from "../contract/atlas-instance";
import { readSeed } from "./global-setup";

/**
 * Browser acceptance for the Phase 5 operational pages.
 *
 * Everything asserted here is real Atlas state: `globalSetup` boots an isolated Atlas, the
 * dev server talks only to it, and where a spec needs a fixture the shared seed cannot
 * provide (a delivery row), it creates one through Atlas's own API with the seed's admin
 * bearer. No network response is stubbed anywhere.
 */

let cachedSeed: ReturnType<typeof readSeed> | undefined;
function seed() {
  cachedSeed ??= readSeed();
  return cachedSeed;
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
      connection: "close",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${text}`);
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

  test("artifacts states the global-list limitation with the real lifetime count", async ({
    page,
  }) => {
    await gotoHydrated(page, "/artifacts");
    await expect(
      page.getByText("Atlas has no global artifact list", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText(/Atlas currently reports \d+ artifacts? across all runs/),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /Browse runs/ })).toBeVisible();
    // The scaffold's invented ledger is gone.
    await expect(page.getByText("art_9210")).toHaveCount(0);
    await expect(page.getByText("analysis_report.pdf")).toHaveCount(0);
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
