import { expect, test, type APIRequestContext, type Cookie, type Page } from "@playwright/test";

import { ADMIN_CREDENTIALS, VIEWER_CREDENTIALS } from "../contract/atlas-instance";
import { readSeed } from "./global-setup";

/**
 * File-order note, same rule `zz-live.spec.ts` documents.
 *
 * `reads.spec.ts` asserts that a 25-row workflow window is *not* full, which is only true while
 * the instance holds fewer than 25 definitions. These tests create one workflow each, so this
 * file has to sort after `reads.spec.ts` — hence the name. It sorts before `zz-live.spec.ts`,
 * which registers the stub worker, and before `zz-resilience.spec.ts`, which must stay last.
 */

let cachedSeed: ReturnType<typeof readSeed> | undefined;
function seedIds() {
  cachedSeed ??= readSeed();
  return cachedSeed;
}

async function signIn(page: Page) {
  await page.goto("/auth");
  await page.locator('form[data-hydrated="true"]').waitFor({ state: "attached" });
  await page.getByLabel("Username").fill(ADMIN_CREDENTIALS.username);
  await page.getByLabel("Password").fill(ADMIN_CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

/**
 * Signs in once for the whole file, then replays the resulting session cookie.
 *
 * Atlas caps a user's concurrent dashboard sessions (`max_active_sessions`, default 5) and
 * revokes the oldest beyond it on every login. `zz-live.spec.ts` still uses the long-lived token
 * `globalSetup` obtained, so a file that logs in once per test spends that budget for nothing and
 * eventually invalidates the seed token out from under a later spec. One login serves all of
 * these tests; each still gets its own isolated context.
 */
let sessionCookies: Cookie[] | null = null;

async function signedIn(page: Page) {
  if (sessionCookies) {
    await page.context().addCookies(sessionCookies);
    return;
  }
  await signIn(page);
  sessionCookies = await page.context().cookies();
}

/** Waits for React to own the page — see the note in `editor.spec.ts`. */
async function ready(page: Page) {
  await page.locator('[data-hydrated="true"]').waitFor({ state: "attached" });
}

const dirtyState = (page: Page) => page.getByTestId("workflow-dirty-state");
const canvas = (page: Page) => page.getByRole("application", { name: "Workflow canvas" });

/**
 * Browser acceptance for the Test Run dialog.
 *
 * Workflows here are created through Atlas's API rather than the canvas, because what each case
 * needs is a *specific prompt* — a start-node reference, a downstream-only reference, a manager
 * reference — and driving the inspector to produce one would test the inspector, which
 * `workflow editor` above already covers.
 *
 * Every run these tests start is a real Atlas run against the harness's deliberately unreachable
 * worker, so it fails within milliseconds. That is fine: what is asserted is that a run was
 * created with the right input and that the page navigated to its real id, never that it
 * succeeded.
 */
test.describe("workflow test run dialog", () => {
  let workflowCounter = 0;

  function atlasHeaders(): Record<string, string> {
    return { authorization: `Bearer ${seedIds().adminToken}` };
  }

  async function createGraph(
    request: APIRequestContext,
    graph: Record<string, unknown>,
  ): Promise<string> {
    workflowCounter += 1;
    const response = await request.post(`${seedIds().atlasOrigin}/api/workflows`, {
      headers: atlasHeaders(),
      data: { name: `E2E test run ${workflowCounter}`, description: "", graph, policy: {} },
    });
    expect(response.status()).toBe(201);
    return ((await response.json()) as { workflow: { id: string } }).workflow.id;
  }

  /** One worker as the start node, carrying whatever prompt the case is about. */
  const startWorker = (prompt: string) => ({
    start: "collect",
    nodes: [{ id: "collect", type: "worker", prompt, outputs: ["collected"] }],
    edges: [],
  });

  /** A start node that needs nothing, feeding a second node that references input. */
  const downstreamNeedsInput = {
    start: "collect",
    nodes: [
      { id: "collect", type: "worker", prompt: "Gather the material." },
      { id: "refine", type: "worker", prompt: "Refine using {input.tone}." },
    ],
    edges: [{ from: "collect", to: "refine", condition: { type: "always" } }],
  };

  async function runCountFor(request: APIRequestContext, workflowId: string): Promise<number> {
    const response = await request.get(
      `${seedIds().atlasOrigin}/api/workflow-runs?limit=100&workflow_definition_id=${workflowId}`,
      { headers: atlasHeaders() },
    );
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { runs: unknown[] }).runs.length;
  }

  async function openEditor(page: Page, workflowId: string) {
    await page.goto(`/workflows/${workflowId}`);
    await ready(page);
    // Long: a cold dev server compiles the editor chunk on the first visit of a run.
    await expect(dirtyState(page)).toHaveText("Saved", { timeout: 30_000 });
  }

  const testRunButton = (page: Page) =>
    page.getByRole("button", { name: "Run live test", exact: true });
  const clickTestRun = async (page: Page) => {
    const button = testRunButton(page);
    await button.focus();
    await button.evaluate((element) => (element as HTMLButtonElement).click());
  };
  const dialog = (page: Page) => page.getByRole("dialog");

  test.beforeEach(async ({ page }) => {
    await signedIn(page);
  });

  test("opens, contains focus, closes on Escape, and returns focus to its button", async ({
    page,
    request,
  }) => {
    const id = await createGraph(request, startWorker("Collect {input.topic}."));
    await openEditor(page, id);

    await clickTestRun(page);
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveAttribute("aria-describedby", /.+/);
    await expect(page.getByRole("heading", { name: /^Run live test/ })).toBeVisible();

    // Radix moves focus into the dialog; the textarea is labelled and reachable.
    await expect(page.getByLabel("Run input JSON")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    // Focus must come back to what opened it, or a keyboard user is stranded at the document.
    await expect(testRunButton(page)).toBeFocused();
  });

  test("opening it starts nothing", async ({ page, request }) => {
    const id = await createGraph(request, startWorker("Collect {input.topic}."));
    expect(await runCountFor(request, id)).toBe(0);

    await openEditor(page, id);
    await clickTestRun(page);
    await expect(dialog(page)).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog(page)).toHaveCount(0);

    // The whole point of replacing the one-click Run: reading the contract costs nothing.
    expect(await runCountFor(request, id)).toBe(0);
  });

  test("prefills the observed skeleton and lets it be edited", async ({ page, request }) => {
    const id = await createGraph(request, startWorker("Review {input.applicant.name}."));
    await openEditor(page, id);
    await clickTestRun(page);

    const input = page.getByTestId("test-run-input");
    // Nested, and its value is an obvious placeholder rather than an invented typed default.
    await expect(input).toHaveValue(/"applicant":\s*\{\s*"name":\s*"<input\.applicant\.name>"/);

    await input.fill('{"applicant":{"name":"เจ้าของอาคาร"}}');
    await expect(input).toHaveValue('{"applicant":{"name":"เจ้าของอาคาร"}}');
    await expect(page.getByTestId("test-run-problem")).toHaveCount(0);
    await expect(page.getByTestId("start-test-run")).toBeEnabled();
  });

  test("refuses malformed JSON and every non-object root", async ({ page, request }) => {
    const id = await createGraph(request, startWorker("Do the thing."));
    await openEditor(page, id);
    await clickTestRun(page);

    const input = page.getByTestId("test-run-input");
    const start = page.getByTestId("start-test-run");
    const problem = page.getByTestId("test-run-problem");

    await input.fill("{ oops");
    await expect(problem).toContainText(/not valid JSON/);
    await expect(start).toBeDisabled();
    // The error is associated with the field, not merely near it.
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toHaveAttribute("aria-describedby", /test-run-problem/);

    for (const [root, described] of [
      ["[]", "an array"],
      ['"text"', "string"],
      ["12", "number"],
      ["true", "boolean"],
      ["null", "null"],
    ]) {
      await input.fill(root!);
      await expect(problem).toContainText(described!);
      await expect(start).toBeDisabled();
    }

    await input.fill("{}");
    await expect(problem).toHaveCount(0);
    await expect(start).toBeEnabled();
  });

  test("blocks when the start worker's own reference is missing", async ({ page, request }) => {
    const id = await createGraph(request, startWorker("Review {input.applicant_name}."));
    await openEditor(page, id);
    await clickTestRun(page);

    await page.getByTestId("test-run-input").fill("{}");

    const problem = page.getByTestId("test-run-problem");
    await expect(problem).toContainText("input.applicant_name");
    // Blocking is justified by Atlas's behaviour, and the copy says which behaviour.
    await expect(problem).toContainText("before any branch is chosen");
    await expect(page.getByTestId("start-test-run")).toBeDisabled();
  });

  test("only warns for a downstream reference, and never calls it a schema", async ({
    page,
    request,
  }) => {
    const id = await createGraph(request, downstreamNeedsInput);
    await openEditor(page, id);
    await clickTestRun(page);

    await page.getByTestId("test-run-input").fill("{}");

    const warnings = page.getByTestId("test-run-warnings");
    await expect(warnings).toContainText("input.tone");
    await expect(warnings).toContainText("Observed, not enforced");
    await expect(warnings).toContainText("may not run on every path");
    // A warning is not a requirement: the run can still be started.
    await expect(page.getByTestId("test-run-problem")).toHaveCount(0);
    await expect(page.getByTestId("start-test-run")).toBeEnabled();
  });

  test("one explicit submit creates exactly one real run and navigates to it", async ({
    page,
    request,
  }) => {
    const id = await createGraph(request, startWorker("Review {input.topic}."));
    await openEditor(page, id);
    await clickTestRun(page);

    await page.getByTestId("test-run-input").fill('{"topic":"a distinctive test topic"}');
    await page.getByTestId("start-test-run").click();

    await page.waitForURL(/\/runs\/wfr_[a-z0-9]+$/);
    const runId = new URL(page.url()).pathname.split("/").pop()!;
    expect(runId).toMatch(/^wfr_/);
    expect(await runCountFor(request, id)).toBe(1);

    // Atlas persisted exactly what was typed. This is the claim the dialog exists to make good.
    const stored = await request.get(`${seedIds().atlasOrigin}/api/workflow-runs/${runId}`, {
      headers: atlasHeaders(),
    });
    const { run } = (await stored.json()) as { run: { input: Record<string, unknown> } };
    expect(run.input).toMatchObject({ topic: "a distinctive test topic" });
  });

  test("a Disabled workflow's start is refused with copy naming the status and the fix", async ({
    page,
    request,
  }) => {
    const id = await createGraph(request, startWorker("Do the thing."));
    const disabled = await request.put(`${seedIds().atlasOrigin}/api/workflows/${id}`, {
      headers: atlasHeaders(),
      data: { status: "disabled" },
    });
    expect(disabled.ok()).toBe(true);

    await openEditor(page, id);
    await clickTestRun(page);
    await page.getByTestId("start-test-run").click();

    // Atlas's stable workflow_not_runnable refusal arrives as actionable copy: it names the
    // current status and the next action, instead of exposing a raw error token.
    const error = page.getByTestId("test-run-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("Disabled");
    await expect(error).toContainText("Active");
    // The refusal created no run, and the dialog stays open with the payload intact.
    expect(await runCountFor(request, id)).toBe(0);
    await expect(dialog(page)).toBeVisible();
  });

  test("keeps Atlas's refusal on screen instead of closing over it", async ({ page, request }) => {
    const id = await createGraph(request, startWorker("Do the thing."));
    await openEditor(page, id);
    await clickTestRun(page);

    // Deleting the definition underneath the open dialog is the cleanest way to make Atlas
    // refuse a start that this UI otherwise considers valid.
    const deleted = await request.delete(`${seedIds().atlasOrigin}/api/workflows/${id}`, {
      headers: atlasHeaders(),
    });
    expect(deleted.ok()).toBe(true);

    await page.getByTestId("start-test-run").click();

    const error = page.getByTestId("test-run-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText(/Unknown workflow_definition_id|not found/i);
    // Still open, still holding the payload — a closed dialog would mean retyping it.
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByTestId("test-run-input")).toHaveValue(/\{/);
  });

  test("labels the integration guidance observed, and never as a schema", async ({
    page,
    request,
  }) => {
    const id = await createGraph(request, startWorker("Review {input.topic}."));
    await openEditor(page, id);
    await clickTestRun(page);
    await page.getByTestId("integration-details").locator("summary").click();

    await expect(page.getByTestId("observed-badge")).toContainText(
      "Observed · not enforced by Atlas",
    );
    // The two categories are visibly separate, and only one of them is Atlas's word.
    await expect(page.getByRole("heading", { name: "Official Atlas API facts" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Observed workflow facts" })).toBeVisible();

    await expect(page.getByTestId("observed-input-paths")).toContainText("input.topic");
    await expect(page.getByTestId("observed-outputs")).toContainText("possible output");

    const text = (await dialog(page).innerText()).toLowerCase();
    for (const forbidden of ["type-safe", "is required", "openapi", "json schema", "guaranteed"]) {
      expect(text, `integration copy must not say "${forbidden}"`).not.toContain(forbidden);
    }
    // The one place "enforced" may appear is the negative claim itself.
    expect(text).toContain("not enforced by atlas");
  });

  test("states the dedupe gap and that a JSON field is not a file upload", async ({
    page,
    request,
  }) => {
    const id = await createGraph(request, startWorker("Do the thing."));
    await openEditor(page, id);
    await clickTestRun(page);
    await page.getByTestId("integration-details").locator("summary").click();

    const text = await dialog(page).innerText();
    expect(text).toContain("two POSTs are two runs");
    expect(text).toContain("/fire");
    expect(text).toContain("never an uploaded file");
  });

  test("copied and downloaded examples carry no test value, token, or private origin", async ({
    page,
    context,
    request,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const id = await createGraph(request, startWorker("Review {input.topic}."));
    await openEditor(page, id);
    await clickTestRun(page);

    // A value that would be unmistakable if it ever leaked into a generated artefact.
    const secretish = "SUPER-SECRET-TEST-VALUE-42";
    await page.getByTestId("test-run-input").fill(`{"topic":"${secretish}"}`);
    await page.getByTestId("integration-details").locator("summary").click();

    const atlasOrigin = seedIds().atlasOrigin;
    const adminToken = seedIds().adminToken;

    const assertSafe = (content: string, what: string) => {
      expect(content, `${what} leaked the entered test value`).not.toContain(secretish);
      expect(content, `${what} leaked the private Atlas origin`).not.toContain(atlasOrigin);
      expect(content, `${what} leaked a bearer`).not.toContain(adminToken);
      expect(content, `${what} must use the placeholder origin`).toContain("$ATLAS_BASE_URL");
    };

    await page.getByRole("button", { name: "Copy" }).first().click();
    assertSafe(await page.evaluate(() => navigator.clipboard.readText()), "the copied cURL");

    const download = await Promise.race([
      page.waitForEvent("download"),
      page
        .getByRole("button", { name: "Download JSON" })
        .click()
        .then(() => page.waitForEvent("download")),
    ]);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const downloaded = Buffer.concat(chunks).toString("utf8");

    expect(downloaded, "the download leaked the entered test value").not.toContain(secretish);
    expect(downloaded, "the download leaked the private Atlas origin").not.toContain(atlasOrigin);
    expect(downloaded, "the download leaked a bearer").not.toContain(adminToken);
    expect(JSON.parse(downloaded)).toMatchObject({ observed: true, enforced_by_atlas: false });
  });

  /**
   * Two clicks dispatched back to back, not one click plus an assertion that the button looks
   * disabled.
   *
   * `disabled` and the "Starting…" label are both React state, so they only exist on a later
   * render; a burst inside a single task sees neither. Atlas has no dedupe key on
   * `POST /api/workflow-runs`, so a second dispatch that got through would be a second real run
   * and a second worker's budget. Both clicks are issued from one page evaluation, which is the
   * closest a test can get to a genuine double-click.
   */
  test("two immediate clicks produce exactly one start request and one run", async ({
    page,
    request,
  }) => {
    const id = await createGraph(request, startWorker("Do the thing."));
    await openEditor(page, id);

    // Count what actually leaves the browser, not what the component believes it did.
    let startRequests = 0;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/_serverFn/**", async (route) => {
      const body = route.request().postData() ?? "";
      if (route.request().method() !== "POST" || !body.includes("workflowDefinitionId")) {
        return route.continue();
      }
      startRequests += 1;
      await held;
      await route.continue();
    });

    await clickTestRun(page);
    const start = page.getByTestId("start-test-run");
    await expect(start).toBeEnabled();

    // Both dispatched synchronously, in one task, before React can re-render in between.
    await start.evaluate((button: HTMLElement) => {
      button.click();
      button.click();
    });

    await expect(start).toBeDisabled();
    await expect(start).toHaveText("Starting…");
    await expect(start).toHaveAttribute("aria-busy", "true");
    // Escape must not dismiss an unresolved start; Atlas may already have created the run.
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeVisible();

    release();
    await page.waitForURL(/\/runs\/wfr_[a-z0-9]+$/);

    expect(startRequests, "start requests that left the browser").toBe(1);
    expect(await runCountFor(request, id), "runs Atlas created").toBe(1);
  });

  /**
   * Another tab saves; this tab's query refetches while its canvas stays put.
   *
   * The editor is keyed on the workflow id alone so a background refetch cannot discard what
   * someone is typing — which means the canvas can legitimately lag the stored graph. Atlas runs
   * the *stored* graph, so testing from a lagging canvas would execute something the operator
   * never saw. The page has to notice and say so rather than quietly disagree with itself.
   */
  test("a save from another tab blocks Test run until this one reloads", async ({
    page,
    context,
    request,
  }) => {
    const id = await createGraph(request, startWorker("Collect {input.topic}."));
    await openEditor(page, id);
    await expect(testRunButton(page)).toBeEnabled();

    // Tab B: a second real tab in the same session, editing and saving the same workflow.
    const tabB = await context.newPage();
    await signedIn(tabB);
    await tabB.goto(`/workflows/${id}`);
    await ready(tabB);
    await expect(dirtyState(tabB)).toHaveText("Saved", { timeout: 30_000 });
    await tabB.getByRole("button", { name: /^Wait for branches/ }).click();
    await expect(dirtyState(tabB)).toHaveText("Unsaved changes");
    await tabB.getByRole("button", { name: "Save" }).click();
    await expect(dirtyState(tabB)).toHaveText("Saved");

    /**
     * Returning to tab A is what makes its query refetch: TanStack's focus manager listens for
     * `visibilitychange` on `window` and refetches a stale query on the hidden→visible edge.
     *
     * Headless Chromium does not actually background a page when another is opened, so the
     * transition is driven here. Everything downstream of it — the refetch, the version
     * comparison, the banner, the withheld button — is the real production path, and tab B's
     * save above was a real save through a real second editor.
     */
    await page.bringToFront();
    await page.evaluate(() => {
      const visibility = (value: string) =>
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => value,
        });
      visibility("hidden");
      window.dispatchEvent(new Event("visibilitychange"));
      visibility("visible");
      window.dispatchEvent(new Event("visibilitychange"));
    });

    const banner = page.getByTestId("workflow-server-moved");
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText("saved elsewhere");

    // Tab A's canvas still shows what it always showed — nothing was thrown away...
    await expect(dirtyState(page)).toHaveText("Saved");
    await expect(canvas(page).locator('[data-node-kind="join"]')).toHaveCount(0);
    // ...and the one action that would have run the *other* graph is withheld, with the reason.
    await expect(testRunButton(page)).toBeDisabled();
    await expect(testRunButton(page)).toHaveAttribute("aria-describedby", "workflow-readiness");
    await expect(page.locator("#workflow-readiness")).toContainText("Reload before testing");

    // Reloading reconciles all three: canvas, contract, and the graph Atlas would run.
    await page.getByRole("button", { name: "Reload server state" }).click();
    await expect(banner).toHaveCount(0);
    await expect(canvas(page).locator('[data-node-kind="join"]')).toHaveCount(1);
    await expect(testRunButton(page)).toBeEnabled();

    await tabB.close();
  });

  test("clears what was typed when it closes, and does not bring it back", async ({
    page,
    request,
  }) => {
    const id = await createGraph(request, startWorker("Review {input.topic}."));
    await openEditor(page, id);

    const marker = "MARKER-MUST-NOT-SURVIVE-CLOSE";
    await clickTestRun(page);
    await page.getByTestId("test-run-input").fill(`{"topic":"${marker}"}`);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog(page)).toHaveCount(0);

    // Not parked in the closed dialog's DOM, and not in any browser storage.
    expect(await page.content()).not.toContain(marker);
    expect(
      await page.evaluate((needle) => {
        const scan = (store: Storage) =>
          Object.keys(store).some((key) => (store.getItem(key) ?? "").includes(needle));
        return scan(window.localStorage) || scan(window.sessionStorage);
      }, marker),
    ).toBe(false);

    // Reopening offers the generated example again, never the previous payload.
    await clickTestRun(page);
    await expect(page.getByTestId("test-run-input")).toHaveValue(/<input\.topic>/);
    await expect(page.getByTestId("test-run-input")).not.toHaveValue(new RegExp(marker));
  });

  /**
   * Every Copy and Download the Integration tab offers, not just the first of each.
   *
   * The leak this guards against is per-artefact: one snippet built from the wrong source would
   * be the only one carrying a real value, and checking only the first would miss it.
   */
  test("no Copy or Download variant carries a test value, token, or private origin", async ({
    page,
    context,
    request,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const id = await createGraph(request, startWorker("Review {input.topic}."));
    await openEditor(page, id);
    await clickTestRun(page);

    const secretish = "SUPER-SECRET-TEST-VALUE-42";
    await page.getByTestId("test-run-input").fill(`{"topic":"${secretish}"}`);
    await page.getByTestId("integration-details").locator("summary").click();

    const atlasOrigin = seedIds().atlasOrigin;
    const adminToken = seedIds().adminToken;
    const assertSafe = (content: string, what: string) => {
      expect(content, `${what} leaked the entered test value`).not.toContain(secretish);
      expect(content, `${what} leaked the private Atlas origin`).not.toContain(atlasOrigin);
      expect(content, `${what} leaked a bearer`).not.toContain(adminToken);
    };

    const copyButtons = page.getByRole("button", { name: "Copy", exact: true });
    const copyCount = await copyButtons.count();
    // cURL, TypeScript, Python, approvals, webhook.
    expect(copyCount).toBe(5);
    for (let index = 0; index < copyCount; index += 1) {
      await copyButtons.nth(index).click();
      assertSafe(await page.evaluate(() => navigator.clipboard.readText()), `copy #${index}`);
    }

    for (const name of ["Download JSON", "Download Markdown"]) {
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name }).click(),
      ]);
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      assertSafe(Buffer.concat(chunks).toString("utf8"), name);
    }
  });

  /**
   * The RPC endpoint is reachable directly, so the guards that matter are the server's.
   *
   * A route `beforeLoad` and a disabled button prove nothing about a hand-made POST. These three
   * cases go straight at the production boundary with a captured real request URL.
   */
  test("the start-run endpoint refuses a non-object root, an anonymous caller, and a viewer", async ({
    page,
    browser,
    request,
  }) => {
    const id = await createGraph(request, startWorker("Do the thing."));
    await openEditor(page, id);

    // Capture a genuine start request so the URL and headers are the app's own, not invented.
    const [rpc] = await Promise.all([
      page.waitForRequest(
        (candidate) =>
          candidate.method() === "POST" &&
          candidate.url().includes("_serverFn") &&
          (candidate.postData() ?? "").includes("workflowDefinitionId"),
      ),
      (async () => {
        await clickTestRun(page);
        await page.getByTestId("start-test-run").click();
      })(),
    ]);
    await page.waitForURL(/\/runs\/wfr_[a-z0-9]+$/);

    const rpcUrl = rpc.url();
    // The framework encodes server-function arguments (Seroval), so the captured body is replayed
    // verbatim for the session cases rather than hand-written — a hand-written body would test
    // the transport's decoder instead of the guard under examination.
    const realBody = rpc.postData()!;
    const realHeaders = rpc.headers();
    const wireHeaders = (origin: string, referer: string) => ({
      accept: realHeaders.accept!,
      "content-type": realHeaders["content-type"]!,
      "x-tsr-serverfn": "true",
      origin,
      referer,
      "sec-fetch-site": "same-origin",
    });
    const appOrigin = new URL(page.url()).origin;

    /**
     * 1. A non-object `input`, from the signed-in session.
     *
     * `{"t":1,"s":…}` is Seroval's string node, taken from the captured body's own encoding of
     * `workflowDefinitionId`. Every non-object root is covered from the client in "refuses
     * malformed JSON and every non-object root"; what this adds is that the *server* refuses one
     * too, for a caller who never went near the dialog.
     */
    const nonObjectInput = realBody.replace(
      /\{"t":10,"i":2,"p":\{"k":\[\],"v":\[\]\},"o":0\}/,
      '{"t":1,"s":"definitely-not-an-object"}',
    );
    expect(nonObjectInput, "the input node was found and replaced").not.toBe(realBody);

    const nonObject = await page.request.post(rpcUrl, {
      headers: wireHeaders(appOrigin, page.url()),
      data: nonObjectInput,
    });
    /**
     * Asserted on the payload, not the status.
     *
     * A `createServerFn` validator rejection is transported as HTTP **200** carrying an error
     * envelope — the framework's own convention, not this app's. Asserting `>= 400` here would
     * have failed against correct behaviour, and asserting `< 400` would pass against a handler
     * that had happily started a run. The refusal text and the absence of a run id are what
     * actually distinguish the two.
     */
    const nonObjectBody = await nonObject.text();
    expect(nonObjectBody).toContain("input must be an object.");
    expect(nonObjectBody).not.toMatch(/wfr_/);

    // 2. No session at all. The `request` fixture has its own cookie jar, so this really is
    // anonymous — `context.request` would quietly reuse the signed-in browser session.
    const anonymous = await request.post(rpcUrl, {
      headers: wireHeaders(appOrigin, `${appOrigin}/workflows/${id}`),
      data: realBody,
    });
    const anonymousBody = await anonymous.text();
    // No session means no Atlas bearer to forward, so this can never reach a run.
    expect(anonymousBody).not.toMatch(/wfr_/);
    expect(anonymousBody).toMatch(/unauthor|sign in|session/i);

    // 3. A real viewer session, in its own context: a second page in *this* context would carry
    // the admin cookie and never see the login form at all.
    const viewerContext = await browser.newContext();
    const viewerPage = await viewerContext.newPage();
    await viewerPage.goto("/auth");
    await viewerPage.locator('form[data-hydrated="true"]').waitFor({ state: "attached" });
    await viewerPage.getByLabel("Username").fill(VIEWER_CREDENTIALS.username);
    await viewerPage.getByLabel("Password").fill(VIEWER_CREDENTIALS.password);
    await viewerPage.getByRole("button", { name: "Sign in" }).click();
    await expect(viewerPage).toHaveURL(/\/dashboard$/);

    const asViewer = await viewerPage.request.post(rpcUrl, {
      headers: wireHeaders(appOrigin, viewerPage.url()),
      data: realBody,
    });
    // Atlas is the authority here: the same well-formed request that worked as admin is refused
    // for this role, and no run id comes back.
    expect(await asViewer.text()).not.toMatch(/wfr_/);

    // And the viewer's UI does not offer a control that could only fail. This is a courtesy,
    // not the gate — the RPC assertion above is what proves a viewer cannot actually start one.
    await viewerPage.goto(`/workflows/${id}`);
    await ready(viewerPage);
    const viewerRun = viewerPage.getByRole("button", { name: "Run live test", exact: true });
    await expect(viewerRun).toBeDisabled();
    await expect(viewerRun).toHaveAttribute("aria-describedby", "workflow-readiness");
    await expect(viewerPage.locator("#workflow-readiness")).toContainText(
      "role cannot start workflow runs",
    );
    await viewerContext.close();

    // Exactly one run exists: the deliberate one at the top of this test.
    expect(await runCountFor(request, id)).toBe(1);
  });

  test("shows the run's input on its detail page only, collapsed and warned", async ({
    page,
    request,
  }) => {
    const id = await createGraph(request, startWorker("Review {input.topic}."));
    await openEditor(page, id);
    await clickTestRun(page);

    const marker = "PII-MARKER-ON-DETAIL-ONLY";
    await page.getByTestId("test-run-input").fill(`{"topic":"${marker}"}`);
    await page.getByTestId("start-test-run").click();
    await page.waitForURL(/\/runs\/wfr_[a-z0-9]+$/);

    // Collapsed: the payload is not in the rendered text until someone asks for it.
    const preview = page.getByTestId("run-input-preview");
    await expect(page.getByTestId("run-input")).toBeVisible();
    await expect(preview).toBeHidden();

    await page.getByText("Show the input this run was started with").click();
    await expect(preview).toContainText(marker);
    await expect(page.getByText(/may contain personal or otherwise sensitive data/)).toBeVisible();

    /**
     * ...and never on the list — asserted on the wire, not on the rendered DOM.
     *
     * A DOM check only proves the list does not *display* the payload. The claim that matters is
     * that it never reaches the browser at all: `GET /api/workflow-runs` is a `SELECT *`, so
     * every listed run carries its input server-side, and `toRunView` is what drops it. Reading
     * the response bodies is the only thing that can catch a mapper change putting it back.
     */
    const listBodies: string[] = [];
    page.on("response", (response) => {
      if (!response.url().includes("_serverFn")) return;
      void response
        .text()
        .then((body) => listBodies.push(body))
        .catch(() => {
          // A body that is already gone cannot leak; nothing to record.
        });
    });

    await page.goto(`/runs?limit=100&workflow=${id}`);
    await ready(page);
    await expect(page.getByRole("link", { name: /^wfr_/ }).first()).toBeVisible();

    expect(await page.content()).not.toContain(marker);
    expect(listBodies.length, "run-list RPC responses observed").toBeGreaterThan(0);
    for (const body of listBodies) {
      expect(body, "a run-list response carried business input").not.toContain(marker);
    }
  });
});
