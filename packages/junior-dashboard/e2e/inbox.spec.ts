import { mockAutomationCollection } from "../src/mock-reporting/automation-collection";
import { mockAutomationEditor } from "./automation-editor-fixture";
import { automationReport } from "./automation-fixture";
import {
  answered,
  audit,
  digest,
  license,
  migration,
  mockReviewItems,
  prMerge,
  prReady,
  prReview,
  rollout,
} from "./inbox-fixture";
import { screenshot } from "./screenshot";
import { expect, test } from "./test";

const checkout = "Investigate checkout latency";

test("lists To do first, and the tab badge counts it", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page);
  await page.goto(`${dashboard.baseURL}/`);
  const todo = page.getByRole("region", { name: "To do" });
  // One row per Conversation.
  await expect(
    todo.getByRole("link", { name: new RegExp(checkout) }),
  ).toBeVisible();
  // A Conversation with no title is named after its newest item.
  await expect(
    todo.getByRole("link", { name: new RegExp(audit.title) }),
  ).toBeVisible();
  // The badge and To do read the same server count.
  const tab = page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: /^Inbox, \d+ waiting$/ });
  const badge = (await tab.getAttribute("aria-label"))!.replace(/\D/g, "");
  await expect(
    page.getByRole("navigation", { name: "Inbox" }).getByRole("link", {
      name: `Inbox ${badge}`,
    }),
  ).toBeVisible();
  await expect(todo.getByText(badge, { exact: true })).toBeVisible();
  // The Inbox has no heading of its own, and closed items show only in Done.
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
  await expect(page.getByText(answered.title)).toHaveCount(0);
  // A To do Conversation does not show again under the time sections.
  await expect(
    page
      .getByRole("region", { name: "Today" })
      .getByRole("link", { name: new RegExp(checkout) }),
  ).toHaveCount(0);
  await screenshot(page, "inbox", { lightTheme: true });

  // A collapsed To do stays collapsed after a reload.
  await todo.getByRole("button", { name: /^To do/ }).click();
  await expect(todo.getByRole("list")).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { expanded: false, name: /^To do/ }),
  ).toBeVisible();
  await expect(todo.getByRole("list")).toHaveCount(0);
  await screenshot(page, "inbox-todo-collapsed", { view: "desktop" });
  await page.getByRole("button", { name: /^To do/ }).click();
  await expect(todo.getByRole("list")).toBeVisible();
});

test("each entry lists its own rows under its name", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page, {
    open: [rollout, license, audit, prReady, migration, prMerge, prReview],
  });
  await page.goto(`${dashboard.baseURL}/`);
  const nav = page.getByRole("navigation", { name: "Inbox" });
  await expect(nav.getByRole("link")).toHaveText([
    /^Inbox/,
    /^Snoozed/,
    /^Done$/,
    /^Conversations$/,
    /^Pull requests\s*3$/,
    /^Decisions\s*4$/,
    /^Automations/,
    new RegExp(checkout),
    "Show all",
  ]);
  const sections = page.locator("section[aria-label] section[aria-label]");

  // Pull requests group by state.
  await nav.getByRole("link", { name: /^Pull requests/ }).click();
  await expect(page).toHaveURL(/\/\?view=prs$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Pull requests" }),
  ).toBeVisible();
  await expect(sections).toHaveText([
    /^Review requested/,
    /^Ready to merge/,
    /^Other/,
  ]);
  await expect(
    nav.getByRole("link", { name: /^Pull requests/ }),
  ).toHaveAttribute("aria-current", "page");
  await screenshot(page, "inbox-pull-requests", { lightTheme: true });

  // Decisions group by Conversation, the longest wait first.
  await nav.getByRole("link", { name: /^Decisions/ }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Decisions" }),
  ).toBeVisible();
  await expect(sections).toHaveCount(2);
  await expect(sections.nth(1)).toHaveAccessibleName(checkout);
  await screenshot(page, "inbox-decisions", { lightTheme: true });

  // Conversations lists every Conversation, To do ones too.
  await nav.getByRole("link", { name: "Conversations", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Conversations" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Today" })
      .getByRole("link", { name: new RegExp(checkout) }),
  ).toBeVisible();
  await screenshot(page, "inbox-conversations", { lightTheme: true });

  await nav.getByRole("link", { name: /^Automations/ }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Automations" }),
  ).toBeVisible();
  await screenshot(page, "inbox-automations", { lightTheme: true });
});

test("a row answers its asks in place", async ({ dashboard, page }) => {
  const actions = await mockReviewItems(page);
  await page.goto(`${dashboard.baseURL}/`);
  const todo = page.getByRole("region", { name: "To do" });
  // A pill expands the row. The list stays where it is.
  await todo.getByRole("button", { name: "2 Questions" }).first().click();
  const asks = page.getByRole("region", { name: /: asks$/ });
  await expect(asks).toHaveCount(1);
  await expect(page).toHaveURL(`${dashboard.baseURL}/`);

  // Each item gets its own answer form, so a choice does not carry over.
  // The row is named after its newest open item, which changes as they close.
  const bundle = page.getByRole("region", { name: /: asks$/ });
  const licenseItem = bundle.getByRole("region", { name: license.title });
  const auditItem = bundle.getByRole("region", { name: audit.title });
  await licenseItem.getByRole("radio", { name: "Approve" }).click();
  await expect(
    auditItem.getByRole("radio", { name: "Approve" }),
  ).not.toBeChecked();
  await auditItem.getByRole("radio", { name: "Reject" }).click();
  await auditItem.getByLabel("Anything else?").fill("Ask legal first.");
  // A phone view would remount the row and drop the picks.
  await screenshot(page, "inbox-row-answer", {
    lightTheme: true,
    view: "desktop",
  });
  await auditItem.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => actions.length).toBe(1);
  expect(actions[0]).toMatchObject({
    body: {
      action: "submit",
      answer: { other: "Ask legal first.", values: { decision: ["Reject"] } },
    },
    id: audit.id,
  });
  // The row stays open while it has items.
  await expect(licenseItem).toBeVisible();

  // Done closes every item of the row.
  await bundle.getByRole("button", { name: "Done", exact: true }).click();
  await expect
    .poll(() => actions.map((action) => action.id).sort())
    .toEqual([audit.id, license.id, prReady.id].sort());
});

test("snooze hides a row until it wakes", async ({ dashboard, page }) => {
  await mockReviewItems(page, { open: [license, rollout] });
  await page.goto(`${dashboard.baseURL}/`);
  await page.getByRole("button", { name: `Show asks in ${checkout}` }).click();
  await page.getByRole("button", { name: "Snooze" }).click();
  await expect(
    page.getByRole("dialog", { name: "Snooze until" }),
  ).toBeVisible();
  await screenshot(page, "inbox-snooze", { view: "desktop" });
  await page.getByRole("button", { name: "Tomorrow" }).click();
  const todo = page.getByRole("region", { name: "To do" });
  await expect(
    todo.getByRole("link", { name: new RegExp(checkout) }),
  ).toHaveCount(0);

  const nav = page.getByRole("navigation", { name: "Inbox" });
  await nav.getByRole("link", { name: /^Snoozed/ }).click();
  await expect(page).toHaveURL(/\/\?view=snoozed$/);
  await page.getByRole("button", { name: "Wake" }).click();
  await expect(page.getByText("Nothing snoozed")).toBeVisible();
});

test("a sweep clears only FYI items, with an Undo", async ({
  dashboard,
  page,
}) => {
  // A question for Everyone is still a question, so a sweep leaves it.
  const teamAsk = {
    ...audit,
    addedByConversationId: "slack:C789:1770021600.000900",
    assignedToEveryone: true,
    assignees: [],
    id: "item-team-ask",
    title: "Pick the on-call rotation",
  };
  const actions = await mockReviewItems(page, {
    open: [license, prReady, digest, teamAsk],
  });
  await page.goto(`${dashboard.baseURL}/`);
  // Each section clears its own rows. In To do, the notice in the
  // question's row goes; the question stays.
  await page.getByRole("button", { name: "Clear 1 in To do" }).click();
  await expect(page.getByText("Cleared 1 item")).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Pick the on-call rotation/ }),
  ).toBeVisible();
  // The toast with Undo does not outlast a phone view as well.
  await screenshot(page, "inbox-sweep", { lightTheme: true, view: "desktop" });
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(
    page.getByRole("button", { name: "Clear 1 in To do" }),
  ).toBeVisible();
  // Only section headers clear. No label says "need you".
  await expect(page.getByRole("button", { name: /^Clear/ })).toHaveText(
    Array(await page.getByRole("button", { name: /^Clear/ }).count()).fill(
      /^Clear \d+$/,
    ),
  );
  await expect(page.getByText(/\bneeds? you\b/i)).toHaveCount(0);
  expect(actions).toEqual([]);

  // The sweep closes the items when the Undo window ends.
  await page.getByRole("button", { name: /^Clear \d+ in Today$/ }).click();
  await expect
    .poll(() => actions.map((action) => action.id), { timeout: 10_000 })
    .toContain(digest.id);
  expect(actions.map((action) => action.id)).not.toContain(teamAsk.id);
});

test("a sweep that fails to close an item brings it back", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page, {
    failActions: [digest.id],
    open: [license, digest],
  });
  await page.goto(`${dashboard.baseURL}/`);
  // A sweep closes asks, not Conversations: the row stays, without its FYI.
  const digestFyi = page
    .getByRole("listitem")
    .filter({
      has: page.getByRole("link", { name: /Daily operations digest/ }),
    })
    .getByRole("button", { name: "FYI" });
  await expect(digestFyi).toBeVisible();
  await page.getByRole("button", { name: /^Clear \d+ in Today$/ }).click();
  await expect(digestFyi).toHaveCount(0);
  await expect(page.getByText(/^Could not clear \d+ items?$/)).toBeVisible({
    timeout: 10_000,
  });
  await expect(digestFyi).toBeVisible();
});

test("an Automations row expands in place, and only its buttons leave", async ({
  dashboard,
  page,
}) => {
  const editor = await mockAutomationEditor(page, "scheduled");
  editor.value = { ...editor.value, status: "blocked" };
  const report = structuredClone(automationReport);
  Object.assign(
    report.automations.find((automation) => automation.id === "scheduled-1")!,
    {
      lastRunStatus: "blocked",
      status: "blocked",
      statusReason: "GitHub access expired.",
    },
  );
  await page.route(/\/api\/automations(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: mockAutomationCollection(
        report,
        new URL(route.request().url()).searchParams,
      ),
    }),
  );
  await mockReviewItems(page, {
    automations: mockAutomationCollection(
      report,
      new URLSearchParams({ owner: "me", scope: "attention" }),
    ).total,
    open: [license],
  });
  const lifecycle: unknown[] = [];
  await page.route("**/api/automations/scheduled-1/lifecycle", (route) => {
    lifecycle.push(route.request().postDataJSON());
    return route.fulfill({ json: { ...editor.value, status: "active" } });
  });

  await page.goto(`${dashboard.baseURL}/?view=automations`);
  const blocked = page.getByRole("region", { name: "Blocked" });
  await blocked.getByRole("button", { name: /Weekly project summary/ }).click();
  await expect(page).toHaveURL(/\/\?view=automations$/);
  const details = page.getByRole("region", {
    name: "Weekly project summary: attention",
  });
  await expect(details).toContainText("Blocked: GitHub access expired.");
  await details.getByRole("button", { name: "Resume" }).click();
  await expect
    .poll(() => lifecycle)
    .toEqual([{ action: "resume", revision: editor.value.revision }]);
  await details.getByRole("link", { name: "Open editor" }).click();
  await expect(page).toHaveURL(/\/automations\/scheduled-1\/edit$/);
});

test("Done lists closed items, and a row expands in place", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page);
  await page.goto(`${dashboard.baseURL}/`);
  await page
    .getByRole("navigation", { name: "Inbox" })
    .getByRole("link", { name: "Done", exact: true })
    .click();
  await expect(page).toHaveURL(/\/\?view=done$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Done" }),
  ).toBeVisible();
  const done = page.getByRole("button", { name: /initech license entry/ });
  await expect(done).toContainText("Approve · MIT license, no change.");
  const dismissed = page.getByRole("button", { name: /Digest skipped/ });
  await expect(dismissed).toContainText("Muted both alerts.");
  await done.click();
  await expect(
    page.getByRole("region", {
      name: "Review the initech license entry: how it closed",
    }),
  ).toContainText("Dashboard User closed this");
  await screenshot(page, "inbox-done", { lightTheme: true });
});

test("old Inbox links open the list with the item's row expanded", async ({
  dashboard,
  page,
}) => {
  // The linked item is past the first page, so its row loads on its own.
  await mockReviewItems(page, { open: [audit, rollout], pageSize: 1 });
  await page.goto(`${dashboard.baseURL}/review?item=${rollout.id}`);
  await expect(page).toHaveURL(/\/\?view=inbox$/);
  await expect(
    page.getByRole("region", { name: `${checkout}: asks` }),
  ).toBeVisible();

  await page.goto(`${dashboard.baseURL}/review?bundle=prs`);
  await expect(page).toHaveURL(/\/\?view=prs$/);
  await page.goto(`${dashboard.baseURL}/review`);
  await expect(page).toHaveURL(`${dashboard.baseURL}/`);

  // A closed item opens in Done.
  await page.goto(`${dashboard.baseURL}/review?item=${answered.id}`);
  await expect(page).toHaveURL(/\/\?view=done$/);
  await expect(
    page.getByRole("region", { name: `${answered.title}: how it closed` }),
  ).toBeVisible();
});

test("a failed Automations read does not look like nothing waits", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page, { automations: 0, open: [] });
  await page.route(/\/api\/automations\?scope=attention/, (route) =>
    route.fulfill({ json: { error: "Failed" }, status: 500 }),
  );
  await page.goto(`${dashboard.baseURL}/`);
  await expect(
    page.getByText("Could not load your Automations."),
  ).toBeVisible();
  // With nothing to do, To do hides, and closed items stay in Done.
  await expect(page.getByRole("region", { name: "To do" })).toHaveCount(0);
  await expect(page.getByText(answered.title)).toHaveCount(0);
});
