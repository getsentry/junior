import { test, expect } from "./test";
import { screenshot } from "./screenshot";
import { mockAutomationEditor } from "./automation-editor-fixture";

test("edits an Automation from its drawer, preserves list state, and protects the draft", async ({
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
    /scheduled\/scheduled-1\/edit\?scope=mine&q=weekly/,
  );
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Weekly project summary",
  );
  await screenshot(page, "automation-editor");
  const previewRequest = page.waitForRequest((request) =>
    request.url().endsWith("/scheduled/scheduled-1/preview"),
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
    `${dashboard.baseURL}/automations/list?scope=mine&q=weekly`,
  );
  await expect(
    page.getByText("Automation saved. Changes apply to future work."),
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
  await page.route("**/api/automations/event/event-1", async (route) => {
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
  await page.goto(`${dashboard.baseURL}/automations/event/event-1/edit`);
  await expect(page.getByLabel("Resource identifier")).toHaveValue(
    "getsentry/junior#42",
  );
  await screenshot(page, "automation-event-editor");
  await page
    .getByRole("checkbox", { name: "issue · opened", exact: true })
    .check();
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
  await expect(page).toHaveURL(`${dashboard.baseURL}/automations/list`);
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

test("public non-creators can read settings without fetching the edit API", async ({
  page,
  dashboard,
}) => {
  const editRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/api/automations/") &&
      request.url().endsWith("/edit")
    )
      editRequests.push(request.url());
  });
  await page.goto(`${dashboard.baseURL}/automations/event/event-2/edit`);
  await expect(
    page.getByText("Only Avery Chen can edit this automation."),
  ).toBeVisible();
  await expect(
    page.getByText("Uses Avery Chen’s connected accounts."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(
    0,
  );
  expect(editRequests).toEqual([]);
  await screenshot(page, "automation-settings-readonly");
});
