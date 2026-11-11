import { mockAutomationCollection } from "../src/mock-reporting/automation-collection";
import { mockAutomationEditor } from "./automation-editor-fixture";
import { automationReport } from "./automation-fixture";
import {
  audit,
  conversationId,
  digest,
  license,
  migration,
  mockReviewItems,
  prMerge,
  prReady,
  prReview,
  rollout,
  viewer,
} from "./review-desk-fixture";
import { screenshot } from "./screenshot";
import { expect, test } from "./test";

test("each bundle groups its rows the way its filter reads", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page, {
    open: [rollout, license, audit, prReady, migration, prMerge, prReview],
  });
  await page.goto(`${dashboard.baseURL}/review`);
  const bundles = page.getByRole("complementary", { name: "Inbox bundles" });
  // All's main number is what waits on the viewer, the same as the Inbox
  // tab badge. FYI items count apart.
  const inboxTab = page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Inbox" });
  await expect(inboxTab).toHaveText(/^Inbox\d+$/);
  const badge = (await inboxTab.textContent())!.replace(/\D/g, "");
  await expect(
    bundles.getByRole("link", { name: /^All/ }).getByLabel(/to do/),
  ).toHaveAccessibleName(new RegExp(`^${badge} to do(, \\d+ FYI)?$`));
  await expect(bundles.getByRole("link")).toHaveText([
    /^All/,
    /^Pull requests/,
    /^Decisions/,
    /^Automations/,
    /^Investigate checkout latency/,
    // A Conversation with no title is named after its newest item.
    new RegExp(`^${audit.title}`),
    /^Done$/,
  ]);

  // Pull requests group by state.
  await bundles.getByRole("link", { name: /^Pull requests/ }).click();
  await expect(page).toHaveURL(/[?&]bundle=prs/);
  // Sections, not the toast region.
  const sections = page.locator("section[aria-label]");
  await expect(sections).toHaveText([
    /^Review requested/,
    /^Ready to merge/,
    /^Other/,
  ]);
  await screenshot(page, "review-desk-pull-requests", { view: "desktop" });

  // Decisions group by Conversation, the longest wait first.
  await bundles.getByRole("link", { name: /^Decisions/ }).click();
  const decisions = sections;
  await expect(decisions).toHaveCount(2);
  await expect(decisions.nth(1)).toHaveAccessibleName(
    "Investigate checkout latency",
  );
  await expect(
    decisions.nth(1).getByRole("button", { expanded: false }),
  ).toHaveText([new RegExp(migration.title), new RegExp(rollout.title)]);

  // One Conversation groups by item kind.
  await bundles
    .getByRole("link", { name: /^Investigate checkout latency/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Investigate checkout latency" }),
  ).toBeVisible();
  await expect(sections).toHaveText([/^Decisions/, /^Pull requests/]);
  await expect(
    page.getByRole("link", { name: "Open conversation" }),
  ).toHaveAttribute(
    "href",
    `/conversations/${encodeURIComponent(conversationId)}`,
  );
});

test("the needs-you link groups waiting items by conversation", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page);
  await page.goto(
    `${dashboard.baseURL}/review?filter=needs-you&group=conversation`,
  );
  // The count is Conversations, not items. The notice does not wait on you.
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(
    "By conversation 2 conversations",
  );
  // Everything here involves the viewer, so nothing says "need you".
  await expect(page.getByText(/needs? you/i)).toHaveCount(0);
  const groups = page.locator("section[aria-label]");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(1)).toHaveAccessibleName(
    "Investigate checkout latency",
  );
  await expect(groups.getByRole("button", { expanded: false })).toHaveCount(4);
  await expect(page.getByText(prReady.title)).toHaveCount(0);
  await screenshot(page, "review-desk-needs-you", { view: "desktop" });
});

test("an automation row expands in place and only its buttons leave", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page, { open: [license] });
  const editor = await mockAutomationEditor(page, "scheduled");
  editor.value = { ...editor.value, status: "blocked" };
  const report = structuredClone(automationReport);
  const summary = report.automations.find(
    (automation) => automation.id === "scheduled-1",
  )!;
  Object.assign(summary, {
    lastRunStatus: "blocked",
    status: "blocked",
    statusReason: "GitHub access expired.",
  });
  await page.route(/\/api\/automations(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: mockAutomationCollection(
        report,
        new URL(route.request().url()).searchParams,
      ),
    }),
  );
  const lifecycle: unknown[] = [];
  await page.route("**/api/automations/scheduled-1/lifecycle", (route) => {
    lifecycle.push(route.request().postDataJSON());
    return route.fulfill({ json: { ...editor.value, status: "active" } });
  });

  // All lists the viewer's Automations that need attention in To do.
  await page.goto(`${dashboard.baseURL}/review`);
  const todo = page.getByRole("region", { name: "To do" });
  await expect(
    todo.getByRole("button", { name: /Weekly project summary/ }),
  ).toBeVisible();

  await page
    .getByRole("complementary", { name: "Inbox bundles" })
    .getByRole("link", { name: /^Automations/ })
    .click();
  await expect(page).toHaveURL(/\/review\?bundle=automations$/);
  const blocked = page.getByRole("region", { name: "Blocked" });
  await blocked.getByRole("button", { name: /Weekly project summary/ }).click();
  // A click on the row expands it. It never leaves the inbox.
  await expect(page).toHaveURL(/\/review\?bundle=automations$/);
  const details = page.getByRole("region", {
    name: "Weekly project summary: attention",
  });
  await expect(details).toContainText("Blocked: GitHub access expired.");
  await expect(details).toContainText("Last run blocked");
  await screenshot(page, "review-desk-automation", { view: "desktop" });
  // Collapsing the section hides the open row; it opens no other row.
  const blockedHeading = blocked.getByRole("button", { name: /^Blocked/ });
  await blockedHeading.click();
  await expect(page.getByRole("region", { name: /: attention$/ })).toHaveCount(
    0,
  );
  await blockedHeading.click();
  // A search finds Automations too, though the server search skips them.
  await page
    .getByRole("searchbox", { name: "Search review items" })
    .fill("weekly project");
  await expect(
    page
      .getByRole("list", { name: "Search results" })
      .getByRole("button", { name: /Weekly project summary/ }),
  ).toBeVisible();
  await page.getByRole("searchbox", { name: "Search review items" }).fill("");
  await expect(page).toHaveURL(/\/review\?bundle=automations$/);
  // The row stays open through the collapse and the search.
  await expect(details).toBeVisible();
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
  await page.goto(`${dashboard.baseURL}/review`);
  await page
    .getByRole("complementary", { name: "Inbox bundles" })
    .getByRole("link", { name: "Done", exact: true })
    .click();
  await expect(page).toHaveURL(/\/review\?bundle=done$/);
  // Each row shows its answer or why it closed, and who closed it.
  const done = page.getByRole("button", { name: /initech license entry/ });
  await expect(done).toContainText("Approve · MIT license, no change.");
  await expect(done).toContainText("Dashboard User");
  await expect(done).not.toContainText("Dismissed");
  const dismissed = page.getByRole("button", { name: /Digest skipped/ });
  await expect(dismissed).toContainText("Dismissed");
  await expect(dismissed).toContainText("Muted both alerts.");

  const url = page.url();
  await done.click();
  await expect(
    page.getByRole("region", {
      name: "Review the initech license entry: how it closed",
    }),
  ).toContainText("Dashboard User closed this");
  expect(page.url()).toBe(url);
  // Collapsing the row's section hides it; it opens no other row.
  await page
    .getByRole("region")
    .filter({ has: done })
    .getByRole("button", { expanded: true, name: /^(Today|This week|Earlier)/ })
    .click();
  await expect(
    page.getByRole("region", { name: /: how it closed$/ }),
  ).toHaveCount(0);
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
  await page.goto(`${dashboard.baseURL}/review`);
  // The notice in the question's bundle and the FYI digest go; the
  // questions stay.
  const sweep = page.getByRole("button", {
    name: "Clear 2 in All",
  });
  await sweep.click();
  const digestRow = page.getByRole("button", { name: /Digest skipped/ });
  await expect(digestRow).toHaveCount(0);
  const cleared = page.getByText("Cleared 2 items");
  await expect(cleared).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Pick the on-call rotation/ }),
  ).toBeVisible();
  await screenshot(page, "review-desk-sweep", { view: "desktop" });
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(digestRow).toBeVisible();
  expect(actions).toEqual([]);

  // p pins the active row. A pin keeps it out of a sweep.
  await page.keyboard.press("j");
  await page.keyboard.press("p");
  const pinned = page.getByRole("region", { name: "Pinned" });
  await expect(pinned.getByRole("button", { expanded: false })).toHaveCount(1);

  await page.getByRole("button", { name: "Clear 1 in All" }).click();
  // The sweep closes the items when the Undo window ends.
  await expect
    .poll(() => actions, { timeout: 10_000 })
    .toEqual([{ body: { action: "dismiss" }, id: digest.id }]);
});

test("a sweep that fails to close an item brings it back", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page, {
    failActions: [digest.id],
    open: [license, digest],
  });
  await page.goto(`${dashboard.baseURL}/review`);
  const digestRow = page.getByRole("button", { name: /Digest skipped/ });
  await expect(digestRow).toBeVisible();
  await page.getByRole("button", { name: /^Clear \d+ in All$/ }).click();
  await expect(digestRow).toHaveCount(0);
  await expect(page.getByText(/^Could not clear \d+ items?$/)).toBeVisible({
    timeout: 10_000,
  });
  await expect(digestRow).toBeVisible();
});
