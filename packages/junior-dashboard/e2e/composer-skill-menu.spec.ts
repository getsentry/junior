import type { Page } from "@playwright/test";

import { expect, test } from "./test";
import { desktop, mobile, screenshot } from "./screenshot";

async function routeSkills(page: Page) {
  await page.route("**/api/skills", (route) =>
    route.fulfill({
      json: [
        {
          name: "diff-quality",
          description: "Run a quality pass on a diff before it ships.",
        },
        {
          name: "release-check",
          description:
            "Check release readiness across the release branch, open blockers, and failing checks, then post a short summary to the release channel.",
          disableModelInvocation: true,
        },
        {
          name: "self-update",
          description: "Update this app to the latest Junior release.",
          pluginProvider: "github",
        },
      ],
    }),
  );
  await page.route("**/api/skills/release-check", (route) =>
    route.fulfill({
      json: {
        name: "release-check",
        description: "Check release readiness.",
        disableModelInvocation: true,
        body: "# Release check\n\nCompare the release branch with `main`.",
      },
    }),
  );
}

test("shows skill details and opens SKILL.md from the composer @classic", async ({
  page,
  dashboard,
}) => {
  // Open the menu at the screenshot size, so it lines up with the composer.
  await page.setViewportSize(desktop);
  await routeSkills(page);
  await page.goto(dashboard.baseURL);
  const composer = page.getByLabel("Start a conversation");
  await composer.fill("Run $");
  const skills = page.getByRole("grid", { name: "Skills" });
  await expect(skills.getByRole("row")).toHaveCount(3);
  // Rows show names. The details pane shows the description.
  await expect(skills).not.toContainText("Run a quality pass");

  // The details pane follows the active row.
  await composer.press("ArrowDown");
  const active = skills.getByRole("gridcell", { selected: true });
  await expect(active).toContainText("$release-check");
  await expect(active).toHaveAccessibleDescription(/^App or local skill/);
  await expect(
    page.getByText("then post a short summary to the release channel."),
  ).toBeVisible();
  await screenshot(page, "composer-skill-details", { view: "desktop" });
  await composer.press("ArrowDown");
  await expect(active).toHaveAccessibleDescription(/^From the github plugin/);
  await composer.press("ArrowUp");

  const drawer = page.getByRole("dialog", { name: "$release-check" });
  const closeDrawer = drawer.getByRole("button", {
    name: "Close $release-check",
    exact: true,
  });
  await page.getByRole("button", { name: "View full skill" }).click();
  await expect(drawer).toContainText("Compare the release branch");
  await closeDrawer.click();
  await expect(drawer).toBeHidden();
  await composer.press("ControlOrMeta+i");
  await expect(drawer).toContainText("Compare the release branch");
  await closeDrawer.click();
  // Back in the composer with the caret and the active row where they were.
  await expect(composer).toBeFocused();
  await expect(active).toContainText("$release-check");
  await composer.press("Enter");
  await expect(composer).toHaveValue("Run $release-check ");
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("expands a row and opens SKILL.md from it @classic", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize(mobile);
    await routeSkills(page);
    await page.goto(dashboard.baseURL);
    const composer = page.getByLabel("Start a conversation");
    await composer.fill("$");
    const skills = page.getByRole("grid", { name: "Skills" });
    const row = skills.getByRole("gridcell", { name: /^\$release-check/ });
    const description = skills.getByText("Check release readiness across");
    await expect(row).toBeVisible();
    // No details pane on a narrow screen, and rows show names only.
    await expect(page.getByText("App or local skill")).toBeHidden();
    await expect(description).toHaveCount(0);
    await screenshot(page, "composer-skill-menu", { view: "mobile" });

    const details = page.getByRole("button", {
      name: "Details for $release-check",
    });
    await details.tap();
    await expect(details).toHaveAttribute("aria-expanded", "true");
    await expect(description).toBeVisible();
    await expect(composer).toHaveValue("$");
    await screenshot(page, "composer-skill-menu-expanded", { view: "mobile" });

    await page.getByRole("button", { name: "View full skill" }).tap();
    const drawer = page.getByRole("dialog", { name: "$release-check" });
    await expect(drawer).toContainText("Compare the release branch");
    await expect(composer).toHaveValue("$");
    await drawer
      .getByRole("button", { name: "Close $release-check", exact: true })
      .tap();
    await row.tap();
    await expect(composer).toHaveValue("$release-check ");
  });
});
