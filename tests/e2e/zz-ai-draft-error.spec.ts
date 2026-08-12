/**
 * Browser acceptance for stage D2b-5: a rejected AI draft leads with a plain-language headline
 * and keeps Atlas's exact words one click away.
 *
 * The unit suite already pins the decision logic — which error kind earns a headline, which
 * phase's advice is shown, that `detail` carries the raw string
 * (`tests/unit/workflow-ai-draft.test.ts`). What no unit test can reach is the wiring and the
 * render: that `ActionError` is handed the right phase, that the disclosure is a real
 * `<details>` inside Radix's portal, and that it starts closed. That gap is the whole reason
 * this file exists, and the plan's Definition of Done asks for it by name
 * (`docs/AI_DRAFT_ERROR_UX_PLAN.md`).
 *
 * Nothing is mocked between the browser and the failure. A stub thClaws worker registered under
 * the `workflow_builder` role answers with prose instead of JSON, so Atlas genuinely runs two
 * builder jobs (the first attempt plus its bounded self-repair retry), genuinely fails
 * `_json_from_text`, and genuinely returns its own 400. The string this test opens the
 * disclosure to read is therefore Atlas's, not a fixture's — which is the property that would
 * break if the pass-through were ever quietly replaced with friendlier copy.
 *
 * The `zz-` prefix is load-bearing: Playwright runs spec files in name order with one worker,
 * and `reads.spec.ts` asserts on exactly the globally-seeded rows. This file registers an extra
 * worker in the shared Atlas, so it must sort after those strict-seed assertions.
 */

import { expect, test, type Page } from "@playwright/test";

import { ADMIN_CREDENTIALS } from "../contract/atlas-instance";
import { startStubWorker, type StubWorker } from "../fixtures/thclaws-stub";
import { readSeed } from "./global-setup";

let cachedSeed: ReturnType<typeof readSeed> | undefined;
function seedIds() {
  cachedSeed ??= readSeed();
  return cachedSeed;
}

let stub: StubWorker;
let builderWorkerId = "";

test.beforeAll(async ({ request }) => {
  stub = await startStubWorker();
  const response = await request.post(`${seedIds().atlasOrigin}/api/workers`, {
    headers: { authorization: `Bearer ${seedIds().adminToken}` },
    data: {
      name: "E2E Draft Failure Builder",
      base_url: stub.origin,
      // Atlas picks the builder by this role (`_workflow_builder_worker`). The stub streams
      // plain text frames, which is exactly the reply shape that makes the draft path fail.
      role: "workflow_builder",
    },
  });
  expect(response.status()).toBe(201);
  builderWorkerId = ((await response.json()) as { worker: { id: string } }).worker.id;
});

test.afterAll(async ({ request }) => {
  // Leave the shared Atlas as it was found: a lingering `workflow_builder` role would change
  // `available_roles` for any spec that sorts after this one.
  if (builderWorkerId) {
    await request.delete(`${seedIds().atlasOrigin}/api/workers/${builderWorkerId}`, {
      headers: { authorization: `Bearer ${seedIds().adminToken}` },
    });
  }
  await stub?.close();
});

async function signIn(page: Page) {
  await page.goto("/auth");
  await page.locator('form[data-hydrated="true"]').waitFor({ state: "attached" });
  await page.getByLabel("Username").fill(ADMIN_CREDENTIALS.username);
  await page.getByLabel("Password").fill(ADMIN_CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test.describe("AI draft failure", () => {
  test("leads with a plain-language headline and keeps Atlas's words one click away", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/workflows");
    await page.locator('[data-hydrated="true"]').waitFor({ state: "attached" });

    await page.getByRole("button", { name: "Draft with AI" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Workflow description")).toBeVisible();

    await dialog
      .getByLabel("Workflow description")
      .fill("Approve purchase requests over 50,000 baht.");
    await dialog.getByRole("button", { name: "Generate proposal" }).click();

    // Two builder jobs against the stub, then Atlas's 400. Generous because the bounded
    // self-repair retry is a second real round trip, not a simulated one.
    const alert = dialog.getByRole("alert");
    await expect(alert).toBeVisible({ timeout: 45_000 });

    // 1. The headline is the product's voice, not the validator's.
    await expect(alert).toContainText("could not turn this description into a valid workflow");

    // 2. The raw text is present but NOT on show: a closed <details> keeps the alert scannable.
    const disclosure = alert.locator("details");
    await expect(disclosure).toHaveCount(1);
    await expect(disclosure).not.toHaveJSProperty("open", true);
    await expect(disclosure.locator("summary")).toHaveText("Technical details");

    // 3. One click reveals Atlas's own sentence, verbatim. Matching the literal string Atlas
    //    raises in `_json_from_text` is the point — a friendlier paraphrase here would be a
    //    regression, because this is what a user pastes to an operator.
    const rawText = disclosure.locator("p");
    await expect(rawText).toBeHidden();
    await disclosure.locator("summary").click();
    await expect(rawText).toBeVisible();
    await expect(rawText).toContainText("workflow_builder response must be one JSON object");

    // The headline never replaced the raw text; both are on screen together once opened.
    await expect(alert).toContainText("could not turn this description into a valid workflow");
  });
});
