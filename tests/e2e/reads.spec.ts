import { expect, test, type Page } from "@playwright/test";

import { ADMIN_CREDENTIALS, VIEWER_CREDENTIALS } from "../contract/atlas-instance";
import { readSeed } from "./global-setup";

/**
 * Browser acceptance for the Phase 2 read migration.
 *
 * Every assertion below is about data a *real* Atlas produced: `globalSetup` boots an isolated
 * Atlas, seeds it through Atlas's own API, and writes the resulting ids to a file. Nothing here
 * stubs a network response — a test that did would prove the UI can render a fixture, not that
 * the production read path works.
 */

const seed = readSeed();

async function signIn(page: Page, creds: typeof ADMIN_CREDENTIALS) {
  await page.goto("/auth");
  // /auth is server-rendered; the form publishes `data-hydrated` once React owns it.
  await page.locator('form[data-hydrated="true"]').waitFor({ state: "attached" });
  await page.getByLabel("Username").fill(creds.username);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test.describe("Atlas-backed reads", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, ADMIN_CREDENTIALS);
  });

  test("the dashboard shows Atlas aggregates and the seeded rows", async ({ page }) => {
    // The metrics card reports Atlas's own COUNT(*), not a count of the preview rows.
    await expect(page.getByText("Workers Online")).toBeVisible();
    await expect(page.getByText("0/1", { exact: true })).toBeVisible();

    // Atlas stamps the metrics snapshot, so the header proves the numbers came from Atlas.
    await expect(page.getByText(/aggregates as of \d{4}-\d{2}-\d{2}/)).toBeVisible();

    await expect(page.getByText("Contract Workflow").first()).toBeVisible();
    await expect(page.getByText("Contract Worker").first()).toBeVisible();
  });

  /**
   * The scaffold hardcoded "98.1%" as a 24-hour success rate. Atlas exposes no such aggregate
   * to a `read` role, so the number must not reappear from anywhere.
   */
  test("the dashboard no longer claims a fabricated success rate", async ({ page }) => {
    await expect(page.getByText("98.1%")).toHaveCount(0);
    await expect(page.getByText(/no 24-hour success-rate aggregate/i)).toBeVisible();
  });

  test("fleet lists the worker Atlas actually holds", async ({ page }) => {
    await page.goto("/fleet");

    await expect(page.getByRole("cell", { name: "Contract Worker" })).toBeVisible();
    await expect(page.getByText("http://127.0.0.1:9")).toBeVisible();
    // A never-polled worker is `unknown` with no agent version — not a fabricated one.
    await expect(page.getByText("unknown").first()).toBeVisible();
    await expect(page.getByText("not polled")).toBeVisible();

    // None of the scaffold's invented fleet is present.
    await expect(page.getByText("Reporter · Local")).toHaveCount(0);
    await expect(page.getByText("1.4.2")).toHaveCount(0);
  });

  test("workspaces lists the real workspace and its worker", async ({ page }) => {
    await page.goto("/workspaces");

    // `exact` matters: "/tmp/contract-ws" is a cell in the same row.
    await expect(page.getByRole("cell", { name: "contract-ws", exact: true })).toBeVisible();
    await expect(page.getByText("/tmp/contract-ws")).toBeVisible();
    await expect(page.getByText("Contract Co")).toBeVisible();

    // The scaffold synthesised "/Users/<role>/<key>" and a random "Jobs · 24h" count.
    await expect(page.getByText("/Users/reporter/")).toHaveCount(0);
    await expect(page.getByText("Jobs · 24h")).toHaveCount(0);
  });

  test("workflows lists Atlas definitions and states that it is a bounded window", async ({
    page,
  }) => {
    await page.goto("/workflows");

    await expect(page.getByText("Contract Workflow")).toBeVisible();
    await expect(page.getByText(/Atlas reports no total/)).toBeVisible();

    // The scaffold's static template cards and mock workflows are gone.
    await expect(page.getByText("Data Ingestion Pipeline")).toHaveCount(0);
    await expect(page.getByText("Webhook Ingest")).toHaveCount(0);
  });

  test("a workflow detail survives a full reload", async ({ page }) => {
    await page.goto(`/workflows/${seed.workflowId}`);

    await expect(page.getByRole("heading", { name: "Contract Workflow" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "n1" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "worker" })).toBeVisible();

    await page.reload();

    // Reload is the real test: the scaffold's in-memory store would have lost this.
    await expect(page.getByRole("heading", { name: "Contract Workflow" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "n1" })).toBeVisible();
  });

  test("a run detail survives a full reload", async ({ page }) => {
    await page.goto(`/runs/${seed.runId}`);

    await expect(page.getByRole("heading", { name: seed.runId })).toBeVisible();
    await expect(page.getByText("Runtime nodes")).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: seed.runId })).toBeVisible();
  });

  test("runs list links to a run and filters by workflow through Atlas", async ({ page }) => {
    await page.goto(`/runs?workflow=${seed.workflowId}`);

    await expect(page.getByRole("link", { name: seed.runId })).toBeVisible();
    await expect(page.getByText(/Filtered to workflow/)).toBeVisible();

    // A workflow Atlas has no runs for must produce an empty table, not the unfiltered list.
    await page.goto("/runs?workflow=wfd_no_such_definition");
    await expect(page.getByRole("link", { name: seed.runId })).toHaveCount(0);
  });

  test("the job pane opens from the URL and survives a reload", async ({ page }) => {
    await page.goto("/jobs");
    await expect(page.getByText("Contract fixture job.").first()).toBeVisible();

    await page.getByText("Contract fixture job.").first().click();
    await expect(page).toHaveURL(new RegExp(`job=${seed.jobId}`));
    await expect(page.getByRole("heading", { name: seed.jobId })).toBeVisible();

    await page.reload();
    // The selection lives in the URL, so the pane comes back with real Atlas data.
    await expect(page.getByRole("heading", { name: seed.jobId })).toBeVisible();
    await expect(page.getByText("Contract fixture job.").first()).toBeVisible();

    // The scaffold's canned "Streamed Output" transcript is gone.
    await expect(page.getByText("Extracted 12 priority signals")).toHaveCount(0);
  });

  test("a state filter is applied to the loaded window and says so", async ({ page }) => {
    await page.goto("/jobs?state=succeeded");
    await expect(
      page.getByText(/state filter is applied to that window in the browser/i),
    ).toBeVisible();
  });

  test.describe("not found", () => {
    test("an unknown workflow id renders the not-found state", async ({ page }) => {
      await page.goto("/workflows/wfd_definitely_not_real");

      await expect(page.getByText("Not found")).toBeVisible();
      await expect(page.getByText(/no workflow definition with that id/i)).toBeVisible();
      // Not-found must not be dressed up as an error or a sign-out.
      await expect(page.getByText("Signed out")).toHaveCount(0);
      await expect(page.getByText("Atlas error")).toHaveCount(0);
    });

    test("an unknown run id renders the not-found state", async ({ page }) => {
      await page.goto("/runs/wfr_definitely_not_real");

      await expect(page.getByText("Not found")).toBeVisible();
      await expect(page.getByText(/no run with that id/i)).toBeVisible();
    });

    test("an unknown job id renders not-found inside the detail pane", async ({ page }) => {
      await page.goto("/jobs?job=job_definitely_not_real");

      await expect(page.getByText("Not found")).toBeVisible();
    });
  });

  /**
   * No mock domain collection may survive on a migrated route. These strings only ever existed
   * in the scaffold store, so finding one means a route regressed to reading it.
   */
  test("no migrated route renders a mock domain collection", async ({ page }) => {
    const mockStrings = [
      "Reporter · Local",
      "Anchor · Local 2",
      "Coder · Company Mac",
      "Research → Writer Chain",
      "Data Ingestion Pipeline",
      "job_8829",
      "run_00214",
    ];

    for (const path of ["/dashboard", "/fleet", "/workspaces", "/workflows", "/runs", "/jobs"]) {
      await page.goto(path);
      const body = (await page.locator("body").textContent()) ?? "";
      for (const mock of mockStrings) {
        expect(body, `${path} rendered mock data: ${mock}`).not.toContain(mock);
      }
    }
  });
});

/**
 * Every Phase 2 read requires only Atlas's `read` permission (`atlas/app.py:1195`), which all
 * four roles hold. So the meaningful role test is the inverse of a 403 check: a viewer must see
 * the same data, not be blocked by a frontend that invented its own authorization.
 */
test("a viewer sees the same Atlas data, because Atlas grants every role `read`", async ({
  page,
}) => {
  await signIn(page, VIEWER_CREDENTIALS);

  await expect(page.getByText("Viewer", { exact: true })).toBeVisible();
  await expect(page.getByText("Contract Workflow").first()).toBeVisible();

  await page.goto("/fleet");
  await expect(page.getByRole("cell", { name: "Contract Worker" })).toBeVisible();
  await expect(page.getByText("Not allowed")).toHaveCount(0);

  await page.goto(`/workflows/${seed.workflowId}`);
  await expect(page.getByRole("heading", { name: "Contract Workflow" })).toBeVisible();
});

/**
 * The bearer must stay server-side on the read paths too, not just on login.
 */
test("no Atlas bearer is observable from the browser on a data page", async ({ page }) => {
  await signIn(page, ADMIN_CREDENTIALS);

  const requestUrls: string[] = [];
  page.on("request", (request) => requestUrls.push(request.url()));

  await page.goto("/fleet");
  await expect(page.getByRole("cell", { name: "Contract Worker" })).toBeVisible();

  /**
   * Asserted on content rather than on emptiness.
   *
   * TanStack Router legitimately writes a scroll-restoration entry to `sessionStorage` once a
   * page has been navigated, so "storage is empty" is not a property this app has. What must
   * hold is that no credential is in there — which is what the design actually guarantees, and
   * what a regression would break.
   */
  const storage = await page.evaluate(() => ({
    local: JSON.stringify(window.localStorage),
    session: JSON.stringify(window.sessionStorage),
  }));
  const CREDENTIAL_SHAPED = /token|bearer|authorization|secret|password|fd_session/i;
  expect(storage.local).toBe("{}");
  expect(storage.session).not.toMatch(CREDENTIAL_SHAPED);

  for (const url of requestUrls) {
    expect(url).not.toContain("token=");
    expect(url).not.toContain("Bearer");
  }

  // The session cookie exists and is httpOnly, so page JavaScript cannot read it.
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === "fd_session");
  expect(session?.httpOnly).toBe(true);
  expect(await page.evaluate(() => document.cookie)).not.toContain("fd_session");
});
