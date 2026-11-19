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
          description: `Update this app to the latest Junior release. ${"Read the release notes, bump the package, run the checks, and open a pull request. ".repeat(6)}`,
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
  const composer = page.getByLabel("Continue this conversation");
  // The editor loads after the page. A textarea stands in until then.
  await expect(composer).toHaveAttribute("contenteditable", "true");
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
  // A pointer that rests on a row makes it active.
  await skills.getByRole("gridcell", { name: /^\$diff-quality/ }).hover();
  await expect(active).toContainText("$diff-quality");
  await composer.press("ArrowDown");

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
  await expect(composer).toHaveText("Run $release-check ", {
    useInnerText: true,
  });
});

test("describes the skill reference at the caret @classic", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  await routeSkills(page);
  await page.goto(dashboard.baseURL);
  const composer = page.getByLabel("Continue this conversation");
  // The editor loads after the page. A textarea stands in until then.
  await expect(composer).toHaveAttribute("contenteditable", "true");
  const skills = page.getByRole("grid", { name: "Skills" });
  const card = page.getByRole("group", { name: "$release-check" });
  await composer.fill("Run $rel");
  // Enter before the menu opens sends the message.
  await expect(skills).toBeVisible();
  await composer.press("Enter");
  await expect(composer).toHaveText("Run $release-check ", {
    useInnerText: true,
  });

  // The skill that was just inserted, until the next edit.
  await expect(card).toContainText("then post a short summary");
  await expect(skills).toHaveCount(0);
  await expect(composer).toHaveAccessibleDescription(/^App or local skill/);
  await screenshot(page, "composer-skill-card", { view: "desktop" });
  await composer.pressSequentially("now");
  await expect(card).toHaveCount(0);

  // A caret move into a complete reference shows the card, not the menu.
  for (let step = 0; step < 4; step++) await composer.press("ArrowLeft");
  await expect(card).toBeVisible();
  await expect(skills).toHaveCount(0);
  await card.getByRole("button", { name: "View full skill" }).click();
  const drawer = page.getByRole("dialog", { name: "$release-check" });
  await expect(drawer).toContainText("Compare the release branch");
  await drawer
    .getByRole("button", { name: "Close $release-check", exact: true })
    .click();
  await expect(composer).toBeFocused();
  await expect(card).toBeVisible();
  // A selection closes it, and a collapse back to the same caret reopens it.
  await composer.press("Shift+ArrowLeft");
  await expect(card).toHaveCount(0);
  await composer.press("ArrowRight");
  await expect(card).toBeVisible();
  await composer.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(composer).toHaveText("Run $release-check now", {
    useInnerText: true,
  });

  // An edit in the reference shows the menu instead.
  await composer.press("End");
  for (let step = 0; step < 4; step++) await composer.press("ArrowLeft");
  await expect(card).toBeVisible();
  await composer.press("Backspace");
  await expect(skills).toBeVisible();
  await expect(card).toHaveCount(0);
});

test("a caret move before the skill list loads shows the card @classic", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  await routeSkills(page);
  let release = () => {};
  const loaded = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/skills", async (route) => {
    await loaded;
    await route.fallback();
  });
  await page.goto(dashboard.baseURL);
  const composer = page.getByLabel("Continue this conversation");
  // The editor loads after the page. A textarea stands in until then.
  await expect(composer).toHaveAttribute("contenteditable", "true");
  await composer.fill("Run $release-check now");
  for (let step = 0; step < 4; step++) await composer.press("ArrowLeft");
  release();
  const card = page.getByRole("group", { name: "$release-check" });
  const skills = page.getByRole("grid", { name: "Skills" });
  await expect(card).toBeVisible();
  await expect(skills).toHaveCount(0);
  // Esc closes the card, and the menu does not open in its place.
  await composer.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(skills).toHaveCount(0);
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
    const composer = page.getByLabel("Message your Lead");
    await expect(composer).toHaveAttribute("contenteditable", "true");
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
    await expect(composer).toHaveText("$", { useInnerText: true });
    await screenshot(page, "composer-skill-menu-expanded", { view: "mobile" });

    await page.getByRole("button", { name: "View full skill" }).tap();
    const drawer = page.getByRole("dialog", { name: "$release-check" });
    await expect(drawer).toContainText("Compare the release branch");
    await expect(composer).toHaveText("$", { useInnerText: true });
    await drawer
      .getByRole("button", { name: "Close $release-check", exact: true })
      .tap();
    // Expanding a row scrolls its View full skill button into the menu.
    await page.getByRole("button", { name: "Details for $self-update" }).tap();
    await expect(
      page.getByRole("button", { name: "View full skill" }),
    ).toBeInViewport({ ratio: 1 });
    await row.tap();
    await expect(composer).toHaveText("$release-check ", {
      useInnerText: true,
    });
    await expect(
      page.getByRole("group", { name: "$release-check" }),
    ).toBeVisible();
    await screenshot(page, "composer-skill-card", { view: "mobile" });

    // A long description scrolls in the card, so its button stays in sight.
    await composer.fill("$self");
    await skills.getByRole("gridcell", { name: /^\$self-update/ }).tap();
    await expect(
      page
        .getByRole("group", { name: "$self-update" })
        .getByRole("button", { name: "View full skill" }),
    ).toBeInViewport({ ratio: 1 });
  });
});

test("Esc closes the menu, not the question docked above it @classic", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  await routeSkills(page);
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent("internal:question-qa")}`,
  );
  const question = page.getByRole("region", {
    name: "Question: Approve the payments-v42 rollout",
  });
  await expect(question).toBeVisible();
  const composer = page.getByRole("textbox", {
    name: "Continue this conversation",
  });
  await expect(composer).toHaveAttribute("contenteditable", "true");
  // Type, so the caret is where a person leaves it.
  await composer.pressSequentially("$");
  const skills = page.getByRole("grid", { name: "Skills" });
  await expect(skills).toBeVisible();
  await composer.press("Escape");
  await expect(skills).toBeHidden();
  await expect(question).toBeVisible();

  // The same for the card of an inserted skill.
  await composer.fill("");
  await composer.pressSequentially("$diff");
  await composer.press("Enter");
  const card = page.getByRole("group", { name: "$diff-quality" });
  await expect(card).toBeVisible();
  await composer.press("Escape");
  await expect(card).toBeHidden();
  await expect(question).toBeVisible();
});

test("the pane follows the pointer only after it rests on a row @classic", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  await routeSkills(page);
  await page.goto(dashboard.baseURL);
  const composer = page.getByLabel("Continue this conversation");
  await expect(composer).toHaveAttribute("contenteditable", "true");
  await composer.pressSequentially("Run $");
  const skills = page.getByRole("grid", { name: "Skills" });
  const cell = (name: string) =>
    skills.getByRole("gridcell", { name: new RegExp(`^\\$${name}`) });
  await expect(cell("diff-quality")).toHaveAttribute("aria-selected", "true");

  // The pane waits for the pointer to rest on a row, so it does not follow
  // a pass over rows on the way to it. Arrow keys act at once.
  await cell("release-check").hover();
  await expect(cell("diff-quality")).toHaveAttribute("aria-selected", "true");
  await expect(cell("release-check")).toHaveAttribute("aria-selected", "true");
  await composer.press("ArrowDown");
  await expect(cell("self-update")).toHaveAttribute("aria-selected", "true");
});

test("the reply composer with Details open stays split @classic", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  await page.route("**/api/skills", (route) =>
    route.fulfill({
      json: [
        {
          name: "generate-project-local-verification-skill",
          description: "Make a verify skill.",
        },
        { name: "why", description: "Explain why." },
      ],
    }),
  );
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent("internal:questions-qa")}`,
  );
  await expect(
    page.getByRole("complementary", { name: "Conversation details" }),
  ).toBeVisible();
  const composer = page.getByRole("textbox", {
    name: "Continue this conversation",
  });
  await expect(composer).toHaveAttribute("contenteditable", "true");
  await composer.pressSequentially("$");
  const skills = page.getByRole("grid", { name: "Skills" });
  await expect(skills).toBeVisible();
  // About 606px wide: the list keeps 14rem, long names end in an ellipsis,
  // and the pane shows the whole name.
  await expect(
    page.getByRole("button", { name: "View full skill" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Details for/ })).toHaveCount(
    0,
  );
  await screenshot(page, "composer-skill-split-reply", { view: "desktop" });
});
