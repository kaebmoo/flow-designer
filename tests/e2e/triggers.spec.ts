import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import { ADMIN_CREDENTIALS } from "../contract/atlas-instance";
import { readSeed } from "./global-setup";

/**
 * Browser acceptance for the trigger page's writes.
 *
 * Every assertion is about a row a *real* Atlas stored: `globalSetup` boots an isolated Atlas,
 * and each test drives the browser through the RPC boundary to it. Where a claim the UI makes is
 * really a claim about Atlas — "this type cannot be fired by hand", "this endpoint is the fire
 * path" — the same claim is put to Atlas directly with the admin bearer, so a UI that quietly
 * stopped matching Atlas would fail here rather than keep lying convincingly.
 *
 * Nothing is added to the shared seed. Triggers are created through the UI and deleted again, so
 * the specs that assert on the seeded counts stay unaffected.
 */

/**
 * Read lazily, not at module scope, so `playwright test --list` does not need the seed file.
 * Same reason as `reads.spec.ts`.
 */
let cachedSeed: ReturnType<typeof readSeed> | undefined;
function seedIds() {
  cachedSeed ??= readSeed();
  return cachedSeed;
}

/**
 * Headers for talking to the throwaway Atlas directly.
 *
 * `connection: close` is the Atlas keep-alive desync workaround the production client applies
 * too — a rejected POST otherwise poisons the reused connection. See `docs/ATLAS_LIMITATIONS.md`.
 */
function atlasHeaders(): Record<string, string> {
  return { authorization: `Bearer ${seedIds().adminToken}`, connection: "close" };
}

interface AtlasTrigger {
  id: string;
  name: string;
  type: string;
  /** SQLite has no boolean: Atlas returns this column as 0 or 1, never `true`/`false`. */
  enabled: number | boolean;
  config: Record<string, unknown>;
  workflow_definition_id: string;
  next_fire_at: string | null;
}

async function atlasTriggers(request: APIRequestContext): Promise<AtlasTrigger[]> {
  const response = await request.get(`${seedIds().atlasOrigin}/api/workflow-triggers?limit=500`, {
    headers: atlasHeaders(),
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { triggers: AtlasTrigger[] }).triggers;
}

/** The trigger Atlas holds under this name, or `undefined` if Atlas has none. */
async function atlasTrigger(
  request: APIRequestContext,
  name: string,
): Promise<AtlasTrigger | undefined> {
  return (await atlasTriggers(request)).find((trigger) => trigger.name === name);
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
 * The page is server-rendered, so its buttons are clickable before hydration and a click in that
 * window is swallowed silently. The shell publishes `data-hydrated` once mounted.
 */
async function ready(page: Page) {
  await page.locator('[data-hydrated="true"]').waitFor({ state: "attached" });
}

/** `limit=500` so a trigger created by a test is never outside the window it is asserted in. */
async function openTriggers(page: Page) {
  await page.goto("/triggers?limit=500");
  await ready(page);
}

/** Unique per run, so a test that fails mid-way cannot make the next one ambiguous. */
let nameCounter = 0;
function uniqueName(prefix: string): string {
  nameCounter += 1;
  return `${prefix} ${Date.now().toString(36)}-${nameCounter}`;
}

const row = (page: Page, name: string): Locator => page.getByRole("row").filter({ hasText: name });

const dialog = (page: Page): Locator => page.getByRole("dialog");

async function openNewTriggerForm(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "New trigger" }).click();
  const form = dialog(page);
  await expect(form).toBeVisible();
  return form;
}

/**
 * Creates a trigger of `type` on the seeded workflow through the form, and returns its row.
 *
 * Only the three always-present fields are filled: every type's configuration either has no
 * fields at all or arrives usably pre-filled (a schedule defaults to "every 60 minutes"), which
 * is itself part of what "the form offers this type" has to mean.
 */
async function createTrigger(page: Page, name: string, type: string): Promise<Locator> {
  const form = await openNewTriggerForm(page);
  await form.getByLabel("Name", { exact: true }).fill(name);
  await form.getByLabel("Workflow to start").selectOption(seedIds().workflowId);
  await form.getByLabel("Type", { exact: true }).selectOption(type);
  await form.getByRole("button", { name: "Create trigger" }).click();
  await expect(form).toHaveCount(0);
  return row(page, name);
}

/**
 * Deletes through the confirmation dialog the page puts in front of every delete.
 *
 * The wait for the dialog to *close* is load-bearing, not tidiness. Radix marks everything
 * outside an open dialog `aria-hidden`, so while it is open the table is not in the
 * accessibility tree at all and "the row is gone" is true of every row on the page. The dialog
 * deliberately stays open until Atlas answers (so a failed delete is visible), which is exactly
 * the window in which that assertion would pass for the wrong reason.
 */
async function deleteTrigger(page: Page, name: string) {
  await row(page, name).getByRole("button", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Delete trigger" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(row(page, name)).toHaveCount(0);
}

/** Every type the form offers, with the label the list renders for it. */
const TRIGGER_TYPES = [
  { type: "manual", label: "Manual" },
  { type: "schedule", label: "Schedule" },
  { type: "webhook", label: "Webhook" },
  { type: "workflow_run_completed", label: "Workflow run completed" },
  { type: "artifact_created", label: "Artifact created" },
  { type: "worker_status_changed", label: "Worker status changed" },
] as const;

/** The three Atlas refuses to fire by hand (`atlas/app.py:774-775`). */
const EVENT_DRIVEN_TYPES = TRIGGER_TYPES.filter(
  (entry) => !["manual", "schedule", "webhook"].includes(entry.type),
);

test.describe("triggers", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await openTriggers(page);
  });

  test("the form offers exactly the six types Atlas accepts", async ({ page }) => {
    const form = await openNewTriggerForm(page);
    const options = form.getByLabel("Type", { exact: true }).locator("option");
    await expect(options).toHaveCount(TRIGGER_TYPES.length);
    await expect(options).toHaveText(TRIGGER_TYPES.map((entry) => entry.type));
  });

  /**
   * One test per type rather than one loop, so a type that breaks names itself in the report and
   * cannot exhaust another type's time budget.
   */
  for (const { type, label } of TRIGGER_TYPES) {
    test(`a ${type} trigger is created, edited, and deleted in Atlas`, async ({
      page,
      request,
    }) => {
      const name = uniqueName(`E2E ${type}`);
      const created = await createTrigger(page, name, type);

      // The row is rendered from Atlas's list response, so its presence is Atlas's answer — but
      // the type label could still come from a stale draft, hence the direct read below.
      await expect(created).toBeVisible();
      await expect(created).toContainText(label);
      const stored = await atlasTrigger(request, name);
      expect(stored?.type).toBe(type);
      expect(stored?.workflow_definition_id).toBe(seedIds().workflowId);

      const renamed = `${name} renamed`;
      await created.getByRole("button", { name: "Edit" }).click();
      const form = dialog(page);
      await form.getByLabel("Name", { exact: true }).fill(renamed);
      await form.getByRole("button", { name: "Save trigger" }).click();
      await expect(form).toHaveCount(0);

      await expect(row(page, renamed)).toBeVisible();
      // Renamed, not duplicated: Atlas holds the same id under the new name.
      const updated = await atlasTrigger(request, renamed);
      expect(updated?.id).toBe(stored?.id);
      expect(await atlasTrigger(request, name)).toBeUndefined();

      await deleteTrigger(page, renamed);
      expect(await atlasTrigger(request, renamed)).toBeUndefined();
    });
  }

  test("enabling and disabling moves Atlas's own flag, and survives a reload", async ({
    page,
    request,
  }) => {
    const name = uniqueName("E2E toggle");
    const created = await createTrigger(page, name, "manual");
    const toggle = created.getByRole("switch");
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    await toggle.click();
    await expect(page.getByRole("status")).toContainText("Trigger disabled");
    await expect(created.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(Boolean((await atlasTrigger(request, name))?.enabled)).toBe(false);

    // A reload re-reads Atlas rather than a client cache, which is the point: an optimistic
    // switch that never reached Atlas would look identical until this line.
    await page.reload();
    await ready(page);
    await expect(row(page, name).getByRole("switch")).toHaveAttribute("aria-checked", "false");

    await row(page, name).getByRole("switch").click();
    await expect(page.getByRole("status")).toContainText("Trigger enabled");
    expect(Boolean((await atlasTrigger(request, name))?.enabled)).toBe(true);

    await deleteTrigger(page, name);
  });

  /**
   * A schedule is one shape or the other, and Atlas is the authority on that: `config` is
   * replaced wholesale on update (`atlas/db.py:1511`), so a form that merged the two modes would
   * store both keys and let `next_fire_at_for_trigger` silently prefer the interval.
   */
  test("a schedule stores an interval or a daily time, never both and never neither", async ({
    page,
    request,
  }) => {
    const name = uniqueName("E2E schedule");
    const form = await openNewTriggerForm(page);
    await form.getByLabel("Name", { exact: true }).fill(name);
    await form.getByLabel("Workflow to start").selectOption(seedIds().workflowId);
    await form.getByLabel("Type", { exact: true }).selectOption("schedule");

    // Never neither: the mode is a two-way radio with one always chosen, so there is no state of
    // the form that submits an empty schedule config.
    await expect(form.getByRole("radio")).toHaveCount(2);
    await expect(form.getByRole("radio", { checked: true })).toHaveCount(1);

    // Never both: only the chosen mode's field exists at all.
    await expect(form.getByLabel("Interval (minutes)")).toBeVisible();
    await expect(form.getByLabel("Daily time (Atlas host time)")).toHaveCount(0);
    await form.getByRole("radio", { name: "Once a day at" }).check();
    await expect(form.getByLabel("Daily time (Atlas host time)")).toBeVisible();
    await expect(form.getByLabel("Interval (minutes)")).toHaveCount(0);

    await form.getByRole("radio", { name: "Every N minutes" }).check();
    await form.getByLabel("Interval (minutes)").fill("15");
    await form.getByRole("button", { name: "Create trigger" }).click();
    await expect(form).toHaveCount(0);

    const interval = await atlasTrigger(request, name);
    expect(interval?.config).toEqual({ interval_minutes: 15 });
    // Atlas computed a slot from it, which is the only proof the config was understood.
    expect(interval?.next_fire_at).toBeTruthy();

    await row(page, name).getByRole("button", { name: "Edit" }).click();
    const edit = dialog(page);
    await edit.getByRole("radio", { name: "Once a day at" }).check();
    await edit.getByLabel("Daily time (Atlas host time)").fill("07:30");
    await edit.getByRole("button", { name: "Save trigger" }).click();
    await expect(edit).toHaveCount(0);

    // Exactly one key: the interval did not survive the switch as a second, ignored field.
    const daily = await atlasTrigger(request, name);
    expect(daily?.config).toEqual({ daily_time: "07:30" });
    await expect(row(page, name)).toContainText("Daily at 07:30");

    await deleteTrigger(page, name);
  });

  /**
   * The three event types cannot be fired by hand — Atlas raises before it even reads the body
   * (`atlas/app.py:774-775`). The page's claim is checked against Atlas rather than trusted.
   *
   * **Not asserted as visible text:** this page states the reason only in the button's `title`,
   * unlike the run page, which prints its blocked reasons into the document. A `title` is
   * invisible to anyone not hovering, and a disabled button has `pointer-events: none`, so it is
   * not reachable by hover either.
   */
  test("an event-driven trigger cannot be fired by hand, and Atlas agrees", async ({
    page,
    request,
  }) => {
    const manual = uniqueName("E2E fireable");
    await createTrigger(page, manual, "manual");
    // The contrast that makes the assertions below mean something: the control is not simply
    // disabled for every row.
    await expect(row(page, manual).getByRole("button", { name: "Fire" })).toBeEnabled();

    for (const { type, label } of EVENT_DRIVEN_TYPES) {
      const name = uniqueName(`E2E ${type}`);
      await createTrigger(page, name, type);

      const fire = row(page, name).getByRole("button", { name: "Fire" });
      await expect(fire).toBeDisabled();
      await expect(fire).toHaveAttribute(
        "title",
        new RegExp(`${label.toLowerCase()} triggers.*cannot be fired by hand`),
      );

      // Atlas's own refusal, so the disabled button is not the frontend inventing a rule.
      const stored = await atlasTrigger(request, name);
      const refused = await request.post(
        `${seedIds().atlasOrigin}/api/workflow-triggers/${stored!.id}/fire`,
        { headers: atlasHeaders(), data: {} },
      );
      expect(refused.status()).toBe(400);
      expect(await refused.text()).toContain(`${type} triggers are fired by Atlas events`);

      await deleteTrigger(page, name);
    }

    await deleteTrigger(page, manual);
  });

  /**
   * Atlas has no user-chosen webhook path: a trigger is fired at its own id-scoped route, so the
   * only way this can be right is for the printed id to be the one Atlas minted.
   */
  test("a webhook trigger shows the fire path Atlas actually listens on", async ({
    page,
    request,
  }) => {
    const name = uniqueName("E2E webhook");
    const created = await createTrigger(page, name, "webhook");

    const stored = await atlasTrigger(request, name);
    expect(stored?.type).toBe("webhook");
    await expect(created).toContainText(`POST /api/workflow-triggers/${stored!.id}/fire`);

    // That path is not decoration — Atlas accepts a fire on it. 202 is Atlas's answer for an
    // accepted fire; the run it starts then fails against the deliberately unreachable seeded
    // worker, which is irrelevant here and deliberately not asserted on.
    const fired = await request.post(
      `${seedIds().atlasOrigin}/api/workflow-triggers/${stored!.id}/fire`,
      { headers: atlasHeaders(), data: {} },
    );
    expect(fired.status()).toBe(202);

    await deleteTrigger(page, name);
  });

  test("deleting asks first, and keeping it leaves the trigger in Atlas", async ({
    page,
    request,
  }) => {
    const name = uniqueName("E2E delete");
    const created = await createTrigger(page, name, "manual");

    await created.getByRole("button", { name: "Delete" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("Delete this trigger?");
    await expect(confirm).toContainText("This cannot be undone.");

    await confirm.getByRole("button", { name: "Keep it" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(created).toBeVisible();
    expect(await atlasTrigger(request, name)).toBeDefined();

    await deleteTrigger(page, name);
    expect(await atlasTrigger(request, name)).toBeUndefined();
  });

  /**
   * An Atlas rejection is shown as Atlas wrote it.
   *
   * The interval is large enough that Atlas's `base + timedelta(minutes=...)` overflows
   * (`atlas/workflows.py:1867-1872`) — a limit the form deliberately does not reproduce, since
   * the client cannot know Atlas's clock arithmetic. It passes the form's own floor check and
   * the RPC validator's, so the only thing that can refuse it is Atlas.
   */
  test("an Atlas rejection is shown with Atlas's own message", async ({ page, request }) => {
    const name = uniqueName("E2E rejected");
    const form = await openNewTriggerForm(page);
    await form.getByLabel("Name", { exact: true }).fill(name);
    await form.getByLabel("Workflow to start").selectOption(seedIds().workflowId);
    await form.getByLabel("Type", { exact: true }).selectOption("schedule");
    await form.getByLabel("Interval (minutes)").fill("999999999999999");
    await form.getByRole("button", { name: "Create trigger" }).click();

    // The dialog stays open holding the draft, and prints Atlas's sentence rather than a
    // generic "could not save".
    await expect(form).toBeVisible();
    await expect(form).toContainText("schedule interval_minutes is too large");
    expect(await atlasTrigger(request, name)).toBeUndefined();
  });
});
