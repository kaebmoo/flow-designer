import { expect, test, type Page } from "@playwright/test";

import { ADMIN_CREDENTIALS } from "../contract/atlas-instance";

/**
 * Phase 6 design-token rendering checks.
 *
 * The static scan proves no literal colours remain in source; these prove the promoted
 * tokens actually *render* — a token wired to a missing custom property computes to
 * transparent, which the scan alone could never catch.
 */

async function signIn(page: Page) {
  await page.goto("/auth");
  await page.locator('form[data-hydrated="true"]').waitFor({ state: "attached" });
  await page.getByLabel("Username").fill(ADMIN_CREDENTIALS.username);
  await page.getByLabel("Password").fill(ADMIN_CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

const TRANSPARENT = /^rgba\(0,\s*0,\s*0,\s*0\)$|^transparent$/;

test("the dialog overlay dims through the overlay token", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Workers", exact: true }).click();
  await page.locator('[data-hydrated="true"]').first().waitFor({ state: "attached" });

  await page.getByRole("button", { name: "Delete Contract Worker" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();

  // Radix renders the overlay as the dialog content's previous sibling layer.
  const overlayColor = await page.evaluate(() => {
    const overlay = document.querySelector(
      '[data-slot="alert-dialog-overlay"], [class*="overlay" i]',
    );
    return overlay ? getComputedStyle(overlay).backgroundColor : null;
  });
  expect(overlayColor).not.toBeNull();
  expect(overlayColor!).not.toMatch(TRANSPARENT);
  // oklch(0 0 0 / 0.8): black at 80% however the browser serialises it.
  expect(overlayColor!).toMatch(/oklch\(0 0 0 \/ 0\.8\)|rgba\(0, 0, 0, 0\.8\)/);

  await page.keyboard.press("Escape");
});

test("table header/hover washes and the canvas backdrop render from their tokens", async ({
  page,
}) => {
  await signIn(page);

  // Table header wash (bg-highlight/[0.03]) is present, not transparent.
  await page.getByRole("link", { name: "Jobs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Jobs" })).toBeVisible();
  const theadColor = await page.evaluate(
    () => getComputedStyle(document.querySelector("thead")!).backgroundColor,
  );
  expect(theadColor).not.toMatch(TRANSPARENT);

  // Canvas edge labels resolve React Flow's variables to the promoted tokens — a broken
  // token would compute to the RF white default here. The seeded "Contract Workflow"
  // deliberately fails closed in the editor (its worker node carries a `label`), so a fresh
  // editable workflow is created through the UI, exactly as the editor suite does.
  await page.goto("/workflows?limit=100");
  await page.locator('[data-hydrated="true"]').first().waitFor({ state: "attached" });
  await page.getByRole("button", { name: /New workflow/ }).click();
  await page.waitForURL(/\/workflows\/wfd_[a-z0-9]+$/);
  // First visit compiles the editor chunk in the dev server; the canvas mounts after
  // hydration, so give it the long timeout.
  await expect(page.locator(".react-flow").first()).toBeVisible({ timeout: 30_000 });
  const edgeLabelBackground = await page.evaluate(() => {
    const flow = document.querySelector(".react-flow");
    return flow
      ? getComputedStyle(flow).getPropertyValue("--xy-edge-label-background-color").trim()
      : null;
  });
  expect(edgeLabelBackground).toBe("#101a27");

  // Zoom controls stay legible: the button surface comes from --color-card, not white.
  const controlBg = await page.evaluate(() => {
    const button = document.querySelector(".react-flow__controls button");
    return button ? getComputedStyle(button).backgroundColor : null;
  });
  expect(controlBg).not.toBeNull();
  expect(controlBg!).not.toBe("rgb(255, 255, 255)");
  expect(controlBg!).not.toMatch(TRANSPARENT);
});

test("status pills keep a visible border and text besides their tone colour", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Jobs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Jobs" })).toBeVisible();

  // The seeded job failed → a danger pill with readable text, a border, and the state word
  // itself (colour is never the only signal).
  const pill = page.getByText("failed", { exact: true }).first();
  await expect(pill).toBeVisible();
  const styles = await pill.evaluate((el) => {
    const computed = getComputedStyle(el.closest("span") ?? el);
    return { border: computed.borderTopWidth, color: computed.color };
  });
  expect(styles.border).not.toBe("0px");
  expect(styles.color).not.toMatch(TRANSPARENT);
});
