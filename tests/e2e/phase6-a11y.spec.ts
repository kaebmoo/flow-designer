import { expect, test, type Page } from "@playwright/test";

import { ADMIN_CREDENTIALS, VIEWER_CREDENTIALS } from "../contract/atlas-instance";
import { readSeed } from "./global-setup";

/**
 * Phase 6 accessibility and destructive-action acceptance.
 *
 * Keyboard and focus behaviour is asserted on the real DOM: Radix owns the dialog focus trap,
 * but what is verified here is the wiring this app is responsible for — accessible names on
 * icon-only controls, focus landing in (and returning from) the right place, Escape semantics,
 * confirmation dialogs that wait for Atlas, and duplicate-submit guards.
 */

async function signIn(page: Page, creds: { username: string; password: string }) {
  await page.goto("/auth");
  await page.locator('form[data-hydrated="true"]').waitFor({ state: "attached" });
  await page.getByLabel("Username").fill(creds.username);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function waitForHydration(page: Page) {
  await page.locator('[data-hydrated="true"]').first().waitFor({ state: "attached" });
}

test("a destructive dialog holds focus, closes on Escape, and returns focus to its trigger", async ({
  page,
}) => {
  await signIn(page, ADMIN_CREDENTIALS);
  await page.getByRole("link", { name: "Workers", exact: true }).click();
  await waitForHydration(page);

  // Icon-only controls are reachable by their accessible names.
  const deleteButton = page.getByRole("button", { name: "Delete Contract Worker" });
  await expect(page.getByRole("button", { name: "Poll Contract Worker" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit Contract Worker" })).toBeVisible();

  await deleteButton.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();

  // Focus is inside the dialog, and Tab keeps it there (Radix trap, asserted on real DOM).
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const dialogEl = document.querySelector('[role="alertdialog"]');
        return dialogEl?.contains(document.activeElement) ?? false;
      }),
    )
    .toBe(true);
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => {
        const dialogEl = document.querySelector('[role="alertdialog"]');
        return dialogEl?.contains(document.activeElement) ?? false;
      }),
    ).toBe(true);
  }

  // Escape cancels: dialog gone, nothing deleted, focus back on the trigger.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Contract Worker").first()).toBeVisible();
  await expect(deleteButton).toBeFocused();
});

test("the jobs table is keyboard-operable and the detail pane manages focus and Escape", async ({
  page,
}) => {
  const seed = readSeed();
  await signIn(page, ADMIN_CREDENTIALS);
  await page.getByRole("link", { name: "Jobs", exact: true }).click();
  await waitForHydration(page);

  // Reach the seeded job's row by keyboard and open it with Enter.
  const row = page.locator("tr", { hasText: seed.jobId }).first();
  await row.focus();
  await expect(row).toBeFocused();
  await page.keyboard.press("Enter");

  // The pane exists with an accessible name, and focus moved into it.
  const pane = page.getByLabel(`Job ${seed.jobId} details`);
  await expect(pane).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const el = document.querySelector("aside[aria-label]");
        return el?.contains(document.activeElement) ?? false;
      }),
    )
    .toBe(true);

  // Escape closes it.
  await page.keyboard.press("Escape");
  await expect(pane).toHaveCount(0);
});

test("cancel job: terminal jobs are refused with a reason; a viewer is not offered the control", async ({
  page,
}) => {
  const seed = readSeed();
  await signIn(page, ADMIN_CREDENTIALS);
  await page.goto(`/jobs?job=${seed.jobId}`);
  await waitForHydration(page);

  const pane = page.getByLabel(`Job ${seed.jobId} details`);
  await expect(pane).toBeVisible();
  // The seeded job failed (its worker is unroutable), which is a terminal state.
  const cancelButton = pane.getByRole("button", { name: "Cancel job" });
  await expect(cancelButton).toBeDisabled();
  await expect(pane.getByText(/already finished as/)).toBeVisible();

  // A viewer holds no `jobs.run`, so the control is not offered at all (UX only — Atlas
  // would refuse the call anyway).
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/auth$/);
  await signIn(page, VIEWER_CREDENTIALS);
  await page.goto(`/jobs?job=${seed.jobId}`);
  await expect(page.getByLabel(`Job ${seed.jobId} details`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel job" })).toHaveCount(0);
});

test("a slow mutation keeps its dialog open, blocks duplicate submits, and closes on success", async ({
  page,
}) => {
  await signIn(page, ADMIN_CREDENTIALS);
  await page.getByRole("link", { name: "Conversations", exact: true }).click();
  await waitForHydration(page);

  // Hold the create RPC open long enough to observe the pending state; the request still
  // reaches the real server.
  await page.route(
    (url) => url.pathname.includes("/_serverFn/"),
    async (route) => {
      if (route.request().method() === "POST") {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
      }
      await route.continue();
    },
  );

  await page.getByRole("button", { name: "New conversation" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const title = `a11y duplicate submit ${Date.now()}`;
  await dialog.getByLabel(/title/i).fill(title);

  // Enter submits the form (no mouse needed).
  await page.keyboard.press("Enter");

  // While pending: dialog still open, submit disabled — a second submit is impossible.
  const submit = dialog.getByRole("button", { name: /creat/i });
  await expect(submit).toBeDisabled();
  await expect(dialog).toBeVisible();

  // On Atlas's confirmation the dialog closes and the row is real.
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText(title)).toBeVisible();
});

test("navigation announces the current page and auth errors are tied to their fields", async ({
  page,
}) => {
  await signIn(page, ADMIN_CREDENTIALS);
  await expect(page.getByRole("link", { name: "Dashboard", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("link", { name: "Jobs", exact: true }).click();
  await expect(page.getByRole("link", { name: "Jobs", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("link", { name: "Dashboard", exact: true })).not.toHaveAttribute(
    "aria-current",
    "page",
  );

  // The login form's error is programmatically associated with both fields.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.locator('form[data-hydrated="true"]').waitFor({ state: "attached" });
  await page.getByLabel("Username").fill(ADMIN_CREDENTIALS.username);
  await page.getByLabel("Password").fill("wrong-password-for-a11y");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveAttribute("id", "auth-error");
  await expect(page.getByLabel("Username")).toHaveAttribute("aria-describedby", "auth-error");
  await expect(page.getByLabel("Password")).toHaveAttribute("aria-describedby", "auth-error");
});
