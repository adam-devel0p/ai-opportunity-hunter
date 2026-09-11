import { expect, test } from "@playwright/test";

/**
 * Phase 12 acceptance criteria (PLAN.md): Playwright smoke tests for viewing an opportunity's
 * full evidence trail, approve/reject with reason, marking sent, toggling autonomous mode, and
 * manual company entry triggering a real (mocked in test, via `scripts/seedE2eFixture.ts`/direct
 * DB inserts rather than the live `claude` CLI) pipeline run. Run serially against one shared
 * seeded DB (`playwright.config.ts`) — later tests rely on earlier ones' state (e.g. "marking
 * sent" runs after the approve/reject tests, before which the opportunity must still be
 * OUTREACH_READY).
 */

test.describe.serial("AI Opportunity Hunter dashboard", () => {
  test("dashboard shows summary metrics and lets the operator toggle autonomous mode", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("Companies discovered")).toBeVisible();
    await expect(page.getByText("PAUSED", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Resume autonomous research" }).click();
    await expect(page.getByText("RUNNING", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Pause autonomous research" }).click();
    await expect(page.getByText("PAUSED", { exact: true })).toBeVisible();
  });

  test("opportunity list links to the seeded opportunity", async ({ page }) => {
    await page.goto("/opportunities");
    await expect(page.getByRole("heading", { name: "Opportunities" })).toBeVisible();
    await page.getByRole("link", { name: "Northgate Recruitment" }).click();
    await expect(page.getByRole("heading", { name: "Slow applicant screening" })).toBeVisible();
  });

  test("opportunity detail page shows the full evidence trail (spec §44)", async ({ page }) => {
    await page.goto("/opportunities");
    await page.getByRole("link", { name: "Northgate Recruitment" }).click();

    await expect(page.getByText("The careers page lists 12 open roles")).toBeVisible();
    await expect(page.getByText("Facts (1)")).toBeVisible();
    await expect(page.getByText("Inferences / hypotheses (1)")).toBeVisible();
    await expect(page.getByText("Unknowns (1)")).toBeVisible();
    await expect(page.getByRole("link", { name: "Source" }).first()).toHaveAttribute(
      "href",
      "https://northgate-recruitment.example/careers",
    );

    // Human trust sections, spec §85.
    await expect(page.getByRole("heading", { name: "Why Claude likes this" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Why the skeptic might reject it" })).toBeVisible();
    await expect(
      page.getByText("Economic impact relies on an assumed hourly rate"),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "What to verify before contacting them" }),
    ).toBeVisible();

    // Draft email and decision-maker.
    await expect(page.getByText("A quick idea for your applicant screening")).toBeVisible();
    await expect(page.getByText("Jane Doe")).toBeVisible();
  });

  test("operator can approve an opportunity", async ({ page }) => {
    await page.goto("/opportunities");
    await page.getByRole("link", { name: "Northgate Recruitment" }).click();

    await page.getByRole("button", { name: "Approve / Good Opportunity" }).click();
    await expect(page.getByText("Operator: APPROVED")).toBeVisible();
  });

  test("operator can reject an opportunity with a reason (spec §46)", async ({ page }) => {
    await page.goto("/opportunities");
    await page.getByRole("link", { name: "Northgate Recruitment" }).click();

    await page.getByRole("combobox").filter({ hasText: "Rejection reason" }).selectOption("TOO_SMALL");
    await page.getByRole("button", { name: "Reject / Bad Opportunity" }).click();
    await expect(page.getByText("Operator: REJECTED")).toBeVisible();

    // Re-approve so the "marking sent" test below isn't affected by this one's rejection.
    await page.getByRole("button", { name: "Approve / Good Opportunity" }).click();
    await expect(page.getByText("Operator: APPROVED")).toBeVisible();
  });

  test("operator can mark a draft reviewed, then sent manually (spec §41/§45)", async ({ page }) => {
    await page.goto("/opportunities");
    await page.getByRole("link", { name: "Northgate Recruitment" }).click();

    await page.getByRole("button", { name: "Mark Draft Reviewed" }).click();
    await expect(page.getByText("status REVIEWED")).toBeVisible();

    await page.getByRole("button", { name: "Sent Manually" }).click();
    await expect(page.getByText("SENT", { exact: true }).first()).toBeVisible();

    // Recording an outcome after sending (spec §45's Interested/Meeting/etc.).
    await page.getByRole("combobox").filter({ hasText: "Record outcome" }).selectOption("INTERESTED");
    await page.getByRole("button", { name: "Record" }).click();
    await expect(page.getByText("INTERESTED", { exact: true })).toBeVisible();
  });

  test("manual company entry queues a real pipeline run (spec §72)", async ({ page }) => {
    await page.goto("/companies/new");
    await page.getByLabel("Website").fill("https://acme-plumbing.example");
    await page.getByLabel("Name (optional)").fill("Acme Plumbing");
    await page.getByRole("button", { name: "Research this company now" }).click();

    await expect(page.getByRole("heading", { name: "Acme Plumbing" })).toBeVisible();
    await expect(page.getByText("Queued for research")).toBeVisible();
    await expect(page.getByText("RESEARCH_PENDING")).toBeVisible();
  });

  test("operator can toggle DO_NOT_CONTACT and then exclude a company (spec §61/§65)", async ({ page }) => {
    await page.goto("/companies");
    await page.getByRole("link", { name: "Acme Plumbing" }).click();

    await page.getByRole("button", { name: "Mark DO NOT CONTACT" }).click();
    await expect(page.getByText("DO NOT CONTACT", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Allow contact again" })).toBeVisible();

    await page.getByPlaceholder("Reason (optional)").fill("No longer a fit.");
    await page.getByRole("button", { name: "Exclude company" }).click();
    // Two "EXCLUDED" badges appear: lifecycleStatus and the dedicated exclusion badge.
    await expect(page.getByText("EXCLUDED", { exact: true })).toHaveCount(2);
    await expect(page.getByText("No longer a fit.")).toBeVisible();
  });

  test("operator can manage exclusion rules and configure the gate/re-research window from Settings (spec §61/§70)", async ({
    page,
  }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    await page.getByRole("combobox").selectOption("COUNTRY");
    await page.getByPlaceholder("e.g. example.com / gambling / RU").fill("RU");
    await page.getByRole("button", { name: "Add rule" }).click();
    await expect(page.getByText("RU", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("No exclusion rules yet.")).toBeVisible();

    await page.getByLabel("Score threshold (0-100)").fill("80");
    await page.getByRole("button", { name: "Save gate config" }).click();
    await expect(page.getByLabel("Score threshold (0-100)")).toHaveValue("80");

    await expect(page.getByRole("link", { name: "Download everything as JSON" })).toBeVisible();
  });
});
