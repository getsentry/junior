import { test, expect } from "./test";
import { screenshot } from "./screenshot";
import { mockAutomationEditor } from "./automation-editor-fixture";

test("edits an Automation in place, preserves list state, and protects the draft", async ({
  page,
  dashboard,
}) => {
  const state = await mockAutomationEditor(page, "scheduled");
  await page.goto(
    `${dashboard.baseURL}/automations/scheduled-1?scope=mine&q=weekly`,
  );
  await page
    .getByRole("link", { name: "Edit automation", exact: true })
    .click();
  await expect(page).toHaveURL(
    /\/automations\/scheduled-1\/edit\?scope=mine&q=weekly/,
  );
  // Edit mode is part of the Overview tab.
  await expect(
    page
      .getByLabel("Automation navigation")
      .getByRole("link", { name: "Overview", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Weekly project summary",
  );
  const yourChanges = page.getByRole("complementary", {
    name: "Your changes",
  });
  await page.getByLabel("Title", { exact: true }).fill("Temporary title");
  await expect(yourChanges.getByText("Title", { exact: true })).toBeVisible();
  await yourChanges
    .getByRole("button", { name: "Undo title change", exact: true })
    .click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Weekly project summary",
  );
  await expect(
    yourChanges.getByText("No changes yet. Edit a section to see it here."),
  ).toBeVisible();
  await screenshot(page, "automation-editor");
  const previewRequest = page.waitForRequest((request) =>
    request.url().endsWith("/api/automations/scheduled-1/preview"),
  );
  await page.getByLabel("Time", { exact: true }).fill("10:00");
  expect((await previewRequest).postDataJSON()).toMatchObject({
    kind: "recurring",
    frequency: "weekly",
    time: "10:00",
    timezone: "America/Los_Angeles",
    startDate: "2026-08-03",
    weekdays: ["monday"],
  });
  await page.getByRole("button", { name: "Keep saved schedule" }).click();
  await expect(page.getByLabel("Time", { exact: true })).toHaveValue("09:00");

  await page
    .getByLabel("Instruction", { exact: true })
    .fill("Review the weekly changes and link the relevant issues.");
  await page.getByRole("link", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByText("Discard unsaved changes?", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByLabel("Instruction", { exact: true })).toHaveValue(
    "Review the weekly changes and link the relevant issues.",
  );
  await page.getByRole("button", { name: "Add message", exact: true }).click();
  await page
    .getByRole("button", { name: "Move message 2 up", exact: true })
    .click();
  await expect(page.getByLabel("Message 1 destination")).toHaveValue(
    "task_creator",
  );
  await page
    .getByRole("button", { name: "Move message 2 up", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Remove message 2", exact: true })
    .click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/automations/scheduled-1?scope=mine&q=weekly`,
  );
  await expect(
    page.getByText("Automation saved", { exact: true }),
  ).toBeVisible();
  expect(state.writes).toEqual([
    {
      kind: "scheduled",
      revision: "a".repeat(64),
      instruction: "Review the weekly changes and link the relevant issues.",
    },
  ]);
});

test("keeps Event edits through validation, failed saves, and concurrent changes", async ({
  page,
  dashboard,
}) => {
  const state = await mockAutomationEditor(page, "event");
  let attempt = 0;
  await page.route("**/api/automations/event-1", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    attempt++;
    if (attempt === 1)
      return route.fulfill({
        status: 503,
        json: { error: "Service unavailable" },
      });
    if (attempt === 2) {
      state.value = {
        ...state.value,
        title: "Changed in Slack",
        revision: "c".repeat(64),
      };
      return route.fulfill({
        status: 409,
        json: { error: "Changed while editing", code: "conflict" },
      });
    }
    return route.fallback();
  });
  await page.goto(`${dashboard.baseURL}/automations/event-1/edit`);
  await expect(page.getByLabel("Resource identifier")).toHaveValue(
    "getsentry/junior#42",
  );
  await screenshot(page, "automation-event-editor");
  // Only issue.closed sets closedBy, so the filter hides for issue.opened.
  await expect(page.getByLabel("closedBy", { exact: true })).toBeVisible();
  await page
    .getByRole("checkbox", { name: "issue opened", exact: true })
    .check();
  await expect(page.getByLabel("closedBy", { exact: true })).toHaveCount(0);
  await page.getByLabel("state", { exact: true }).selectOption("closed");
  await page.getByLabel("Instruction", { exact: true }).fill("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByLabel("Instruction", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.getByLabel("Instruction", { exact: true })).toBeFocused();
  await page
    .getByLabel("Instruction", { exact: true })
    .fill("Summarize the issue and include a link.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByText("Service unavailable", { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("Instruction", { exact: true })).toHaveValue(
    "Summarize the issue and include a link.",
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("button", { name: "Review latest version" }).click();
  await expect(
    page.getByText("Compare your edits with the latest saved version"),
  ).toBeVisible();
  await screenshot(page, "automation-editor-conflict");
  await page.getByRole("button", { name: "Keep my changed fields" }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Changed in Slack",
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/automations/event-1`);
  expect(state.writes).toEqual([
    {
      kind: "event",
      revision: "c".repeat(64),
      instruction: "Summarize the issue and include a link.",
      trigger: {
        namespace: "github",
        resourceType: "issue",
        identifier: "getsentry/junior#42",
        label: "Issue 42",
        events: ["issue.closed", "issue.opened"],
        match: { state: "closed" },
      },
    },
  ]);
});

test("replaces an Event trigger with one for any resource", async ({
  page,
  dashboard,
}) => {
  const state = await mockAutomationEditor(page, "event");
  await page.goto(`${dashboard.baseURL}/automations/event-1/edit`);
  await page.getByLabel("Resource type").selectOption("github:*");
  await page.getByRole("button", { name: "Replace trigger" }).click();
  await expect(page.getByLabel("Resource identifier")).toHaveCount(0);
  // A trigger with no identifier names no resource.
  await page.getByLabel("Trigger name").fill("Closed issues");
  await page.getByRole("checkbox", { name: /^issue closed/ }).check();
  await screenshot(page, "automation-event-editor-any-resource");
  // The shared check names the filter that this event needs.
  await expect(
    page.getByText('This trigger needs a "state" filter'),
  ).toBeVisible();
  await page.getByLabel("state", { exact: true }).selectOption("closed");
  await expect(
    page.getByText('This trigger needs a "state" filter'),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/automations/event-1`);
  expect(state.writes).toEqual([
    expect.objectContaining({
      kind: "event",
      trigger: {
        namespace: "github",
        label: "Closed issues",
        events: ["issue.closed"],
        match: { state: "closed" },
      },
    }),
  ]);
});

test("public non-creators edit settings without creator-only controls", async ({
  page,
  dashboard,
}) => {
  const state = await mockAutomationEditor(page, "event", "event-2");
  await page.goto(`${dashboard.baseURL}/automations/event-2/edit/`);
  await expect(
    page
      .getByLabel("Automation navigation")
      .getByRole("link", { name: "Overview", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByText(/You can edit it because it is in a public channel/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Add message" })).toHaveCount(
    0,
  );
  await page
    .getByLabel("Instruction", { exact: true })
    .fill("Notify responders and link the incident timeline.");
  await expect(
    page.getByText("Saving switches this automation to system credentials."),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: /Avery Chen’s connected accounts/ }),
  ).toBeDisabled();
  await screenshot(page, "automation-editor-public");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/automations/event-2`);
  expect(state.writes).toEqual([
    {
      kind: "event",
      revision: "a".repeat(64),
      instruction: "Notify responders and link the incident timeline.",
    },
  ]);
});

test("makes an earlier version active from version history", async ({
  page,
  dashboard,
}) => {
  const editor = await mockAutomationEditor(page, "scheduled");
  const definition = {
    title: editor.value.title,
    instruction: editor.value.instruction,
    credentialMode: editor.value.credentialMode,
    destination: editor.value.destination,
    outcomes: editor.value.outcomes,
    schedule:
      editor.value.kind === "scheduled" ? editor.value.schedule : undefined,
  };
  const versions = [
    {
      kind: "scheduled",
      version: 2,
      createdAt: "2026-08-04T16:00:00.000Z",
      editedBy: { slackUserId: "U456", fullName: "Avery Chen" },
      definition: { ...definition, instruction: "Post a shorter summary" },
    },
    {
      kind: "scheduled",
      version: 1,
      createdAt: "2026-07-28T16:00:00.000Z",
      editedBy: null,
      definition,
    },
  ];
  let activeVersion = 2;
  const activations: unknown[] = [];
  await page.route("**/api/automations/scheduled-1/versions", (route) =>
    route.fulfill({
      json: { versions, activeVersion, truncated: false },
    }),
  );
  await page.route(
    "**/api/automations/scheduled-1/versions/1/activate",
    (route) => {
      activations.push(route.request().postDataJSON());
      versions.unshift({
        ...versions.at(-1)!,
        version: 3,
        editedBy: { slackUserId: "U123", fullName: "Morgan" },
      });
      activeVersion = 3;
      return route.fulfill({ json: editor.value });
    },
  );
  await page.goto(`${dashboard.baseURL}/automations/scheduled-1`);
  await page
    .getByRole("complementary", { name: "Automation status" })
    .getByRole("link", { name: "Version 2" })
    .click();
  await expect(page).toHaveURL(/\/automations\/scheduled-1\/versions/);
  const versionList = page.getByRole("navigation", { name: "Versions" });
  await expect(versionList.getByText("Changed what to do")).toBeVisible();
  // The newest version is compared with the one before it.
  await expect(page.getByText("Compared with version 1")).toBeVisible();
  await expect(page.getByText("Added: Post a shorter summary")).toBeAttached();
  await screenshot(page, "automation-versions");
  await versionList.getByRole("button", { name: /^Version 1/ }).click();
  await expect(page).toHaveURL(/[?&]version=1(?:&|$)/);
  await page
    .getByRole("button", { name: "Make version 1 active", exact: true })
    .click();
  await page
    .getByRole("alertdialog", { name: "Make version 1 active?" })
    .getByRole("button", { name: "Make active" })
    .click();
  await expect(
    page.getByText("Version 1 is active again. It was saved as a new version."),
  ).toBeVisible();
  await expect(
    versionList.getByRole("button", { name: /^Version 3/ }),
  ).toContainText("Active");
  expect(activations).toEqual([{ revision: "a".repeat(64) }]);
});
