import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

import { ADMIN_CREDENTIALS, VIEWER_CREDENTIALS } from "../contract/atlas-instance";
import { readSeed } from "./global-setup";

let cachedSeed: ReturnType<typeof readSeed> | undefined;
let adminCookies: Awaited<ReturnType<ReturnType<Page["context"]>["cookies"]>> | undefined;

function seed() {
  cachedSeed ??= readSeed();
  return cachedSeed;
}

const createdWorkflowIds = new Set<string>();

// `pack-ui` is intentionally named after the milestone contract, so it runs before `reads`
// alphabetically. Cleanup removes every imported row before the next file starts; keep this
// mitigation because the file creates real Atlas definitions and must not perturb reads' window.
test.afterAll(async () => {
  for (const workflowId of createdWorkflowIds) {
    const response = await fetch(`${seed().atlasOrigin}/api/workflows/${workflowId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${seed().adminToken}` },
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`pack E2E cleanup failed for ${workflowId}: ${response.status}`);
    }
  }
});

function atlasHeaders() {
  return {
    authorization: `Bearer ${seed().adminToken}`,
    "content-type": "application/json",
  };
}

async function signIn(page: Page, credentials = ADMIN_CREDENTIALS) {
  if (credentials.username === ADMIN_CREDENTIALS.username && adminCookies) {
    await page.context().addCookies(adminCookies);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard$/);
    return;
  }

  await page.goto("/auth");
  await page.locator('form[data-hydrated="true"]').waitFor({ state: "attached" });
  await page.getByLabel("Username").fill(credentials.username);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  if (credentials.username === ADMIN_CREDENTIALS.username) {
    adminCookies = await page.context().cookies();
  }
}

async function ready(page: Page) {
  await page.locator('[data-hydrated="true"]').waitFor({ state: "attached" });
}

async function exportedBundle(workflowId = seed().workflowId): Promise<Record<string, unknown>> {
  const response = await fetch(`${seed().atlasOrigin}/api/packs/${workflowId}/export`, {
    headers: { authorization: `Bearer ${seed().adminToken}` },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { pack: Record<string, unknown> }).pack;
}

async function writeFixture(testInfo: TestInfo, name: string, value: unknown): Promise<string> {
  const path = testInfo.outputPath(name);
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value, null, 2), "utf8");
  return path;
}

async function workflowIds(): Promise<string[]> {
  const response = await fetch(`${seed().atlasOrigin}/api/workflows?limit=500`, {
    headers: { authorization: `Bearer ${seed().adminToken}` },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { workflows: Array<{ id: string }> }).workflows.map(
    (workflow) => workflow.id,
  );
}

test.describe("workflow pack UI", () => {
  test("exports a downloaded JSON bundle from a loaded workflow", async ({ page }) => {
    await signIn(page);
    await page.goto(`/workflows/${seed().workflowId}`);
    await ready(page);

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export pack" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("contract-workflow.pack.json");
    const payload = JSON.parse(await readFile((await download.path())!, "utf8")) as {
      schema_version: number;
      name: string;
    };
    expect(payload.schema_version).toBe(1);
    expect(payload.name).toBe("Contract Workflow");
  });

  test("previews and imports a pack, then shows the new row without reload", async ({
    page,
  }, testInfo) => {
    const bundle = await exportedBundle();
    const fixture = await writeFixture(testInfo, "happy.pack.json", bundle);

    await signIn(page);
    await page.goto("/workflows");
    await ready(page);
    await page.getByRole("button", { name: "Import pack" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('input[type="file"]').setInputFiles(fixture);
    await expect(dialog.getByText("Contract Workflow", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Signed", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("Unsigned", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(dialog.getByText("Pack imported")).toBeVisible();
    const createdLink = dialog.getByRole("link", { name: "Contract Workflow", exact: true });
    await expect(createdLink).toBeVisible();
    const createdPath = await createdLink.getAttribute("href");
    expect(createdPath).toMatch(/^\/workflows\/wfd_/);
    const createdId = createdPath?.split("/").pop();
    expect(createdId).toMatch(/^wfd_/);
    createdWorkflowIds.add(createdId!);

    await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
    await expect(page.getByText("Contract Workflow", { exact: true })).toHaveCount(2);

    const directRead = await fetch(`${seed().atlasOrigin}/api/workflows/${createdId}`, {
      headers: { authorization: `Bearer ${seed().adminToken}` },
    });
    expect(directRead.status).toBe(200);
    const imported = (await directRead.json()) as {
      workflow: { graph: unknown; policy: unknown; interface: unknown };
    };
    const sourceWorkflow = (bundle.workflows as Array<Record<string, unknown>>)[0]!;
    expect(imported.workflow.graph).toEqual(sourceWorkflow.graph);
    expect(imported.workflow.policy).toEqual(sourceWorkflow.policy);
    expect(imported.workflow.interface).toEqual(sourceWorkflow.interface);
  });

  test("shows Atlas's 400 verbatim and keeps the dialog open", async ({ page }, testInfo) => {
    const bundle = await exportedBundle();
    const broken = {
      ...bundle,
      workflows: [
        {
          ...((bundle.workflows as Array<Record<string, unknown>>)[0] ?? {}),
          graph: { start: "missing", nodes: [], edges: [] },
        },
      ],
    };
    const direct = await fetch(`${seed().atlasOrigin}/api/packs/import`, {
      method: "POST",
      headers: atlasHeaders(),
      body: JSON.stringify(broken),
    });
    expect(direct.status).toBe(400);
    const expectedMessage = ((await direct.json()) as { error: string }).error;
    const before = await workflowIds();
    const fixture = await writeFixture(testInfo, "broken.pack.json", broken);

    await signIn(page);
    await page.goto("/workflows");
    await ready(page);
    await page.getByRole("button", { name: "Import pack" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('input[type="file"]').setInputFiles(fixture);
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText(expectedMessage);
    await expect(dialog).toBeVisible();
    expect(await workflowIds()).toEqual(before);
  });

  test("passes an unsupported schema version through to Atlas unchanged", async ({
    page,
  }, testInfo) => {
    const bundle = await exportedBundle();
    const unsupported = { ...bundle, schema_version: 2 };
    const direct = await fetch(`${seed().atlasOrigin}/api/packs/import`, {
      method: "POST",
      headers: atlasHeaders(),
      body: JSON.stringify(unsupported),
    });
    expect(direct.status).toBe(400);
    const expectedMessage = ((await direct.json()) as { error: string }).error;
    const before = await workflowIds();
    const fixture = await writeFixture(testInfo, "unsupported-schema.pack.json", unsupported);

    await signIn(page);
    await page.goto("/workflows");
    await ready(page);
    await page.getByRole("button", { name: "Import pack" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('input[type="file"]').setInputFiles(fixture);
    await expect(dialog.getByRole("status")).toContainText("schema version is 2");
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText(expectedMessage);
    await expect(dialog).toBeVisible();
    expect(await workflowIds()).toEqual(before);
  });

  test("rejects a parse failure in the browser without an Atlas import", async ({
    page,
  }, testInfo) => {
    const before = await workflowIds();
    const fixture = await writeFixture(testInfo, "not-json.txt", "this is not json");

    await signIn(page);
    await page.goto("/workflows");
    await ready(page);
    await page.getByRole("button", { name: "Import pack" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('input[type="file"]').setInputFiles(fixture);
    await expect(dialog.getByRole("alert")).toContainText("not valid JSON");
    await expect(dialog.getByRole("button", { name: "Import", exact: true })).toBeDisabled();
    expect(await workflowIds()).toEqual(before);
  });

  test("the import server boundary refuses an anonymous replay", async ({
    page,
    request,
  }, testInfo) => {
    const bundle = await exportedBundle();
    const fixture = await writeFixture(testInfo, "auth.pack.json", bundle);

    await signIn(page);
    await page.goto("/workflows");
    await ready(page);
    await page.getByRole("button", { name: "Import pack" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('input[type="file"]').setInputFiles(fixture);

    const [rpc] = await Promise.all([
      page.waitForRequest(
        (candidate) =>
          candidate.method() === "POST" &&
          candidate.url().includes("_serverFn") &&
          (candidate.postData() ?? "").includes("Contract Workflow"),
      ),
      dialog.getByRole("button", { name: "Import", exact: true }).click(),
    ]);
    await expect(dialog.getByText("Pack imported")).toBeVisible();

    const createdLink = dialog.getByRole("link", { name: "Contract Workflow", exact: true });
    const createdPath = await createdLink.getAttribute("href");
    const createdId = createdPath?.split("/").pop();
    expect(createdId).toMatch(/^wfd_/);
    createdWorkflowIds.add(createdId!);

    const realHeaders = rpc.headers();
    const appOrigin = new URL(page.url()).origin;
    const anonymous = await request.post(rpc.url(), {
      headers: {
        accept: realHeaders.accept!,
        "content-type": realHeaders["content-type"]!,
        "x-tsr-serverfn": "true",
        origin: appOrigin,
        referer: page.url(),
        "sec-fetch-site": "same-origin",
      },
      data: rpc.postData()!,
    });
    const anonymousBody = await anonymous.text();
    expect(anonymousBody).not.toMatch(/wfd_/);
    expect(anonymousBody).toMatch(/unauthor|sign in|session/i);
  });

  test("clears selection and preview when the dialog closes", async ({ page }, testInfo) => {
    const fixture = await writeFixture(testInfo, "reset.pack.json", await exportedBundle());

    await signIn(page);
    await page.goto("/workflows");
    await ready(page);
    await page.getByRole("button", { name: "Import pack" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.locator('input[type="file"]').setInputFiles(fixture);
    await expect(dialog.getByText("Contract Workflow", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
    await page.getByRole("button", { name: "Import pack" }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Nothing selected", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Contract Workflow", { exact: true })).toHaveCount(0);
  });

  test("shows the viewer role restriction while export remains available", async ({ page }) => {
    await signIn(page, VIEWER_CREDENTIALS);
    await page.goto("/workflows");
    await ready(page);
    await expect(page.getByRole("button", { name: "Import pack" })).toBeDisabled();

    await page.goto(`/workflows/${seed().workflowId}`);
    await ready(page);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export pack" }).click();
    expect(await downloadPromise).toBeTruthy();
  });
});
