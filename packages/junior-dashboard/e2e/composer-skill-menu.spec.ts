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
  const skills = page.getByRole("listbox", { name: "Skills" });
  await expect(skills.getByRole("option")).toHaveCount(3);

  // The details pane follows the active row.
  await composer.press("ArrowDown");
  const active = skills.getByRole("option", { selected: true });
  await expect(active).toContainText("$release-check");
  await expect(active).toHaveAccessibleDescription(/^App or local skill/);
  await expect(
    page.getByText("then post a short summary to the release channel."),
  ).toHaveCount(2);
  await screenshot(page, "composer-skill-details", { view: "desktop" });
  await composer.press("ArrowDown");
  await expect(active).toHaveAccessibleDescription(/^From the github plugin/);
  await composer.press("ArrowUp");

  await composer.press("ControlOrMeta+i");
  const drawer = page.getByRole("dialog", { name: "$release-check" });
  await expect(drawer).toContainText("Compare the release branch");
  await drawer
    .getByRole("button", { name: "Close $release-check", exact: true })
    .click();
  // Back in the composer with the caret and the active row where they were.
  await expect(composer).toBeFocused();
  await expect(active).toContainText("$release-check");
  await composer.press("Enter");
  await expect(composer).toHaveValue("Run $release-check ");
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("opens SKILL.md from a row's info button @classic", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize(mobile);
    await routeSkills(page);
    await page.goto(dashboard.baseURL);
    const composer = page.getByLabel("Start a conversation");
    await composer.fill("$");
    const row = page
      .getByRole("listbox", { name: "Skills" })
      .getByRole("option", { name: /^\$release-check/ });
    await expect(row).toBeVisible();
    // No details pane on a narrow screen.
    await expect(page.getByText("App or local skill")).toBeHidden();
    await screenshot(page, "composer-skill-menu", { view: "mobile" });

    await row.getByTitle("View SKILL.md").tap();
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
