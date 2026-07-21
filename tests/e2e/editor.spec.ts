import { expect, test, type Page } from "@playwright/test";

import { ADMIN_CREDENTIALS } from "../contract/atlas-instance";
import { readSeed } from "./global-setup";

/**
 * Browser acceptance for the Atlas-native workflow editor.
 *
 * Everything below goes through the real path: the browser talks to the RPC boundary, which
 * talks to a real isolated Atlas that `globalSetup` booted and seeded. Nothing is stubbed — a
 * stubbed save would prove the button dispatches an action, not that Atlas stored a graph it
 * will accept back.
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
 * Waits for React to own the page before driving it.
 *
 * Every authenticated page is server-rendered, so its buttons are present and clickable before
 * hydration — and a click in that window is swallowed silently. The shell publishes
 * `data-hydrated` once mounted; waiting on it means these tests exercise the app rather than
 * racing it.
 */
async function ready(page: Page) {
  await page.locator('[data-hydrated="true"]').waitFor({ state: "attached" });
}

/** Creates a workflow through the UI and returns the Atlas id from the resulting URL. */
async function createWorkflow(page: Page): Promise<string> {
  await page.goto("/workflows?limit=100");
  await ready(page);
  await page.getByRole("button", { name: /New workflow/ }).click();
  await page.waitForURL(/\/workflows\/wfd_[a-z0-9]+$/);
  const id = new URL(page.url()).pathname.split("/").pop()!;
  expect(id).toMatch(/^wfd_/);
  return id;
}

const canvas = (page: Page) => page.getByRole("application", { name: "Workflow canvas" });
const dirtyState = (page: Page) => page.getByTestId("workflow-dirty-state");

test.describe("workflow editor", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("the palette offers exactly the four node types Atlas has", async ({ page }) => {
    await createWorkflow(page);

    for (const kind of ["AI Task", "AI Decision", "Wait for branches", "Human decision"]) {
      await expect(page.getByRole("button", { name: new RegExp(`^${kind}`) })).toBeVisible();
    }
    // The four kinds Atlas rejects must not be offerable. A palette entry for any of them would
    // let a user draw a graph that cannot be saved.
    for (const absent of ["Trigger", "Condition", "Loop", "Fan out", "Fan-out"]) {
      await expect(page.getByRole("button", { name: new RegExp(`^${absent}`) })).toHaveCount(0);
    }
  });

  test("the canvas zoom controls keep enough icon contrast to be readable", async ({ page }) => {
    await createWorkflow(page);

    for (const name of ["Zoom in", "Zoom out", "Fit view"]) {
      const button = page.getByRole("button", { name });
      await expect(button).toBeVisible();

      const colors = await button.evaluate((element) => {
        const themeProbe = document.createElement("span");
        themeProbe.style.backgroundColor = "var(--color-card)";
        themeProbe.style.color = "var(--color-foreground)";
        document.body.append(themeProbe);
        const buttonStyle = window.getComputedStyle(element);
        const iconStyle = window.getComputedStyle(element.querySelector("svg")!);
        const themeStyle = window.getComputedStyle(themeProbe);
        const result = {
          background: buttonStyle.backgroundColor,
          icon: iconStyle.fill,
          expectedBackground: themeStyle.backgroundColor,
          expectedIcon: themeStyle.color,
        };
        themeProbe.remove();
        return result;
      });

      expect(colors.background, `${name} button background`).toBe(colors.expectedBackground);
      expect(colors.icon, `${name} icon color`).toBe(colors.expectedIcon);
    }
  });

  test("a saved graph survives a full reload, and the layout is kept separately", async ({
    page,
  }) => {
    const id = await createWorkflow(page);

    // The workflow starts with one worker node; add a second and connect nothing yet.
    await page.getByRole("button", { name: /^AI Decision/ }).click();
    await expect(dirtyState(page)).toHaveText("Unsaved changes");

    // Renaming must rewrite graph.start too, since the first node is the start.
    await page
      .getByRole("button", { name: /^AI Task/ })
      .first()
      .isVisible();
    await canvas(page).getByText("worker_1", { exact: true }).click();
    const idField = page.getByLabel("Node id");
    await idField.fill("collect");
    await idField.blur();
    await expect(canvas(page).getByText("collect", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Save" }).click();
    await expect(dirtyState(page)).toHaveText("Saved");

    // Move a node, which is layout and must NOT make the workflow dirty.
    const node = canvas(page).locator('[data-node-kind="manager"]').first();
    const box = (await node.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2 + 90, { steps: 8 });
    await page.mouse.up();
    await expect(dirtyState(page)).toHaveText("Saved");

    // Compared through stored graph coordinates rather than screen pixels: the canvas fits the
    // view on load, so the same node legitimately lands at different screen coordinates while
    // holding exactly the same position in the graph.
    const readStoredLayout = () =>
      page.evaluate(() => {
        const key = Object.keys(window.localStorage).find((candidate) =>
          candidate.startsWith("flow-designer:layout:"),
        );
        return key
          ? (JSON.parse(window.localStorage.getItem(key)!) as {
              layout_version: number;
              nodes: Record<string, { x: number; y: number }>;
              viewport?: { x: number; y: number; zoom: number };
            })
          : null;
      });

    const beforeReload = await readStoredLayout();
    expect(beforeReload).not.toBeNull();
    expect(beforeReload!.layout_version).toBe(1);
    const movedNodeId = Object.keys(beforeReload!.nodes).find((id) => id.startsWith("manager_"))!;
    expect(movedNodeId).toBeTruthy();

    // Atlas increments the semantic version on every conditional save. The current canvas must
    // be copied to that new key before the editor switches versions.
    await page.getByLabel("Workflow description").fill("saved without moving the canvas");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(dirtyState(page)).toHaveText("Saved");
    const afterVersionBump = await readStoredLayout();
    expect(afterVersionBump!.nodes[movedNodeId]).toEqual(beforeReload!.nodes[movedNodeId]);

    await page.reload();
    await page.waitForURL(new RegExp(`/workflows/${id}$`));
    await ready(page);

    // Semantics came back from Atlas.
    await expect(canvas(page).getByText("collect", { exact: true })).toBeVisible();
    await expect(canvas(page).locator('[data-node-start="true"]')).toHaveCount(1);
    await expect(canvas(page).locator('[data-node-kind="manager"]')).toHaveCount(1);

    // Layout came back from this browser, not from Atlas — the same coordinates, unchanged by a
    // round trip that only ever carried semantics.
    const afterReload = await readStoredLayout();
    expect(afterReload!.nodes[movedNodeId]).toEqual(beforeReload!.nodes[movedNodeId]);
  });

  test("layout is local: clearing it falls back to auto-layout and the graph is untouched", async ({
    page,
  }) => {
    const id = await createWorkflow(page);
    await page.getByRole("button", { name: /^Wait for branches/ }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(dirtyState(page)).toHaveText("Saved");

    // Nothing Atlas stores mentions a position — proven by wiping this browser's storage and
    // seeing the nodes still arrive, arranged by the auto-layout instead.
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await page.waitForURL(new RegExp(`/workflows/${id}$`));
    await ready(page);
    await expect(canvas(page).locator('[data-node-kind="join"]')).toHaveCount(1);
    await expect(canvas(page).locator('[data-node-kind="worker"]')).toHaveCount(1);
  });

  test("keyboard delete removes the node, marks the editor dirty, and clears the inspector", async ({
    page,
  }) => {
    await createWorkflow(page);
    await page.getByRole("button", { name: /^Wait for branches/ }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(dirtyState(page)).toHaveText("Saved");

    await canvas(page).locator('[data-node-kind="join"]').click();
    await expect(page.getByLabel("Node id")).toHaveValue(/join_/);

    await canvas(page).press("Delete");
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation).toContainText(/removes .* related edge/);
    await confirmation.getByRole("button", { name: "Delete node", exact: true }).click();
    await expect(confirmation).toHaveCount(0);

    await expect(canvas(page).locator('[data-node-kind="join"]')).toHaveCount(0);
    // The scaffold's bug: a keyboard delete left the flag clean and the inspector stranded.
    await expect(dirtyState(page)).toHaveText("Unsaved changes");
    await expect(page.getByLabel("Node id")).toHaveCount(0);
  });

  test("the start node cannot be deleted until another entry point is selected", async ({
    page,
  }) => {
    await createWorkflow(page);

    await canvas(page).locator('[data-node-kind="worker"]').click();
    const deleteNode = page.getByRole("button", { name: "Delete node", exact: true });
    await expect(deleteNode).toBeDisabled();
    await expect(deleteNode).toHaveAttribute("title", /Choose a different start node/);

    await canvas(page).press("Delete");
    await expect(canvas(page).locator('[data-node-kind="worker"]')).toHaveCount(1);
    await expect(dirtyState(page)).toHaveText("Saved");
  });

  test("warns before leaving a semantic draft and lets the operator keep editing", async ({
    page,
  }) => {
    await createWorkflow(page);
    await page.getByRole("button", { name: /^Wait for branches/ }).click();

    const workflows = page.getByRole("link", { name: "Workflows", exact: true });
    await workflows.click();
    const warning = page.getByRole("alertdialog");
    await expect(warning).toContainText(/Discard unsaved workflow changes/);
    await warning.getByRole("button", { name: "Keep editing" }).click();
    await expect(page).toHaveURL(/\/workflows\/wfd_[a-z0-9]+$/);

    await workflows.click();
    await warning.getByRole("button", { name: "Discard changes" }).click();
    await expect(page).toHaveURL(/\/workflows\?limit=100$/);
  });

  test("edits and explicitly clears the nullable workflow default reply", async ({ page }) => {
    const id = await createWorkflow(page);
    await page.getByRole("button", { name: "Run policy", exact: true }).click();
    const replyMode = page.getByLabel("Workflow default reply mode");
    await replyMode.selectOption("none");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(dirtyState(page)).toHaveText("Saved");

    await page.reload();
    await page.waitForURL(new RegExp(`/workflows/${id}$`));
    await ready(page);
    await page.getByRole("button", { name: "Run policy", exact: true }).click();
    await expect(page.getByLabel("Workflow default reply mode")).toHaveValue("none");

    await page.getByLabel("Workflow default reply mode").selectOption("clear");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(dirtyState(page)).toHaveText("Saved");
    await page.reload();
    await page.waitForURL(new RegExp(`/workflows/${id}$`));
    await ready(page);
    await page.getByRole("button", { name: "Run policy", exact: true }).click();
    await expect(page.getByLabel("Workflow default reply mode")).toHaveValue("clear");
  });

  test("recovers a semantic draft after the tab loses its sealed session", async ({
    page,
    context,
  }) => {
    const id = await createWorkflow(page);
    await page.getByRole("button", { name: /^Wait for branches/ }).click();
    await expect(dirtyState(page)).toHaveText("Unsaved changes");
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(window.sessionStorage).some((key) => key.includes(":draft:")),
        ),
      )
      .toBe(true);

    await context.clearCookies();
    await page.goto(`/workflows/${id}`);
    await expect(page).toHaveURL(/\/auth$/);
    await signIn(page);
    await page.goto(`/workflows/${id}`);
    await ready(page);

    await expect(page.getByRole("status")).toContainText(/semantic edits.*available/i);
    await page.getByRole("button", { name: "Restore draft" }).click();
    await expect(canvas(page).locator('[data-node-kind="join"]')).toHaveCount(1);
    await expect(dirtyState(page)).toHaveText("Unsaved changes");
  });

  test("local validation blocks the save and each problem selects what it is about", async ({
    page,
  }) => {
    await createWorkflow(page);

    // A quorum join with nothing feeding it is invalid: Atlas requires quorum <= the distinct
    // incoming upstream count, and this one has none.
    await page.getByRole("button", { name: /^Wait for branches/ }).click();
    await page.getByLabel("Mode").selectOption("quorum");

    const problem = page.getByRole("button", { name: /Quorum .* exceeds/ });
    await expect(problem).toBeVisible();
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();

    await page.getByRole("button", { name: "Auto-arrange" }).click();
    await problem.click();
    await expect(page.getByLabel("Node id")).toHaveValue(/join_/);
  });

  /**
   * Built directly in Atlas rather than drawn.
   *
   * The constraint under test is the edge inspector's, and reaching it by simulating a React
   * Flow connection drag tests the drag simulation more than it tests the rule. Creating the
   * graph through Atlas also proves the other half: that a real stored manager graph parses back
   * into the editor intact. **Not covered here:** that dragging a new edge from a manager seeds
   * `manager_selected` — that seeding lives in `onConnect` and has no test.
   */
  test("an edge from a manager can only carry the manager_selected condition", async ({
    page,
    request,
  }) => {
    const seed = seedIds();
    const created = await request.post(`${seed.atlasOrigin}/api/workflows`, {
      headers: { authorization: `Bearer ${seed.adminToken}`, connection: "close" },
      data: {
        name: "Manager routing",
        description: "",
        graph: {
          start: "triage",
          nodes: [
            { id: "triage", type: "manager", schema: "manager_decision_v1", prompt: "Choose." },
            { id: "fast", type: "worker", prompt: "Quick." },
          ],
          edges: [
            {
              from: "triage",
              to: "fast",
              condition: { type: "manager_selected", target: "fast" },
            },
          ],
        },
        policy: {},
      },
    });
    expect(created.status()).toBe(201);
    const workflowId = ((await created.json()) as { workflow: { id: string } }).workflow.id;

    await page.goto(`/workflows/${workflowId}`);
    await ready(page);
    await expect(canvas(page).locator('[data-node-kind="manager"]')).toHaveCount(1);

    await canvas(page).locator(".react-flow__edge").first().click();

    const type = page.getByLabel("Type");
    await expect(type).toHaveValue("manager_selected");
    // The only option. Offering the others and rejecting them afterwards would be a worse
    // version of the same rule.
    await expect(type.locator("option")).toHaveCount(1);
  });

  test("a workflow Atlas stores but this editor cannot model is refused, not partly loaded", async ({
    page,
  }) => {
    // The seeded workflow's node carries a `label`, which Atlas's own validator ignores but the
    // published schema forbids. Loading "the part that parsed" and saving it back would delete
    // whatever was not understood, so the editor refuses the whole graph instead.
    await page.goto(`/workflows/${seedIds().workflowId}`);
    await ready(page);
    await expect(page.getByText("This workflow cannot be opened in the editor")).toBeVisible();
    await expect(page.getByText(/unsupported field/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  });

  test("a save is refused when the workflow changed in Atlas since it was opened", async ({
    page,
    context,
  }) => {
    const id = await createWorkflow(page);
    // A whole second, because Atlas stamps `updated_at` to second resolution: two writes inside
    // the same second are indistinguishable to the guard, which is a documented Atlas
    // limitation rather than something this test should paper over.
    await page.waitForTimeout(1_100);

    // A second tab, signed in as the same operator — the situation the guard exists for.
    const other = await context.newPage();
    await other.goto(`/workflows/${id}`);
    await ready(other);
    await other.getByRole("button", { name: /^Wait for branches/ }).click();
    await other.getByRole("button", { name: "Save" }).click();
    await expect(other.getByTestId("workflow-dirty-state")).toHaveText("Saved");
    await other.close();

    // The first tab still holds the older baseline, so its save must be refused rather than
    // quietly overwriting the other tab's work.
    await page.getByRole("button", { name: /^AI Decision/ }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("alert")).toContainText(/rejected.*version/i);
    await expect(dirtyState(page)).toHaveText("Unsaved changes");
    await page.getByRole("button", { name: "Keep local draft" }).click();
    await expect(page.getByRole("button", { name: "Keep local draft" })).toHaveCount(0);
  });

  test("running a saved workflow returns a real Atlas run id", async ({ page }) => {
    // Nothing to save: "New workflow" creates the row in Atlas, so the editor opens clean.
    await createWorkflow(page);
    await expect(dirtyState(page)).toHaveText("Saved");

    await page.getByRole("button", { name: "Run", exact: true }).click();
    // Atlas mints the id — the scaffold minted `run_000NN` in the browser from an array length.
    await page.waitForURL(/\/runs\/wfr_[a-z0-9]+$/);
    expect(new URL(page.url()).pathname).toMatch(/\/runs\/wfr_/);
  });

  test("run and Atlas validation are unavailable while there are unsaved changes, and say why", async ({
    page,
  }) => {
    await createWorkflow(page);
    await page.getByRole("button", { name: /^Wait for branches/ }).click();
    await expect(dirtyState(page)).toHaveText("Unsaved changes");

    const run = page.getByRole("button", { name: "Run", exact: true });
    await expect(run).toBeDisabled();
    await expect(run).toHaveAttribute("title", /Save first/);

    const check = page.getByRole("button", { name: /Check against Atlas/ });
    await expect(check).toBeDisabled();
    await expect(check).toHaveAttribute("title", /Save first/);
  });

  test("Atlas's rejection lands on the node it is about", async ({ page }) => {
    await createWorkflow(page);
    await canvas(page).locator('[data-node-kind="worker"]').click();
    await page.getByLabel("Worker id").fill("wk_does_not_exist");
    await page.getByRole("button", { name: "Save" }).click();

    // Atlas resolves worker ids against its own table on every write, so this is refused — and
    // its one-sentence message is anchored back to the node, not left as a bare banner.
    await expect(page.getByRole("alert")).toContainText(/unknown worker_id/);
    await expect(page.getByRole("button", { name: /worker_1: .*unknown worker_id/ })).toBeVisible();
    await expect(dirtyState(page)).toHaveText("Unsaved changes");
  });

  test("Atlas confirms a graph whose references it can resolve", async ({ page }) => {
    await createWorkflow(page);
    await expect(dirtyState(page)).toHaveText("Saved");

    await page.getByRole("button", { name: /Check against Atlas/ }).click();
    await expect(page.getByRole("status")).toContainText(/Atlas accepted this graph/);
  });
});
