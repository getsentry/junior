import { mockAutomationCollection } from "../src/mock-reporting/automation-collection";
import { NOW_MS } from "../src/mock-reporting/fixtures";
import { mockAutomationEditor } from "./automation-editor-fixture";
import { automationReport } from "./automation-fixture";
import {
  answered,
  audit,
  digest,
  license,
  migration,
  mockReviewItems,
  mockViewerCodeChanges,
  prMerge,
  prReady,
  prReview,
  rollout,
  rowHead,
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

  // Pull requests list the viewer's open changes, with their asks.
  await nav.getByRole("link", { name: /^Pull requests/ }).click();
  await expect(page).toHaveURL(/\/\?view=prs$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Pull requests" }),
  ).toBeVisible();
  await expect(sections).toHaveText([/^Waiting on you/, /^Waiting on others/]);
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
  await rowHead(page, checkout).click();
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
  await rowHead(page, checkout).click();
  await page.getByRole("button", { name: "Wake" }).click();
  await expect(page.getByText("Nothing snoozed")).toBeVisible();
});

test("a sweep clears only FYI items, with an Undo", async ({
  dashboard,
  page,
}) => {
  // Today is a calendar day, so the clock is fixed: on a real clock, half
  // an hour ago is yesterday just after midnight.
  await page.clock.setFixedTime(NOW_MS);
  // A question for Everyone is still a question, so a sweep leaves it.
  const teamAsk = {
    ...audit,
    addedByConversationId: "slack:C789:1770021600.000900",
    assignedToEveryone: true,
    assignees: [],
    // Recent, so it shows in Today above the older Conversations.
    createdAt: new Date(NOW_MS - 30 * 60_000).toISOString(),
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
    automations: () =>
      mockAutomationCollection(
        report,
        new URLSearchParams({ owner: "me", scope: "attention" }),
      ).total,
    open: [license],
  });
  const lifecycle: unknown[] = [];
  await page.route("**/api/automations/scheduled-1/lifecycle", (route) => {
    lifecycle.push(route.request().postDataJSON());
    Object.assign(
      report.automations.find((automation) => automation.id === "scheduled-1")!,
      { lastRunStatus: "completed", status: "active", statusReason: null },
    );
    return route.fulfill({ json: { ...editor.value, status: "active" } });
  });
  const badge = page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: /^Inbox, \d+ waiting$/ });

  await page.goto(`${dashboard.baseURL}/?view=automations`);
  const blocked = page.getByRole("region", { name: "Blocked" });
  await blocked.getByRole("button", { name: /Weekly project summary/ }).click();
  await expect(page).toHaveURL(/\/\?view=automations$/);
  const details = page.getByRole("region", {
    name: "Weekly project summary: attention",
  });
  await expect(details).toContainText("Blocked: GitHub access expired.");
  const waiting = Number(
    (await badge.getAttribute("aria-label"))!.replace(/\D/g, ""),
  );
  await details.getByRole("link", { name: "Open editor" }).click();
  await expect(page).toHaveURL(/\/automations\/scheduled-1\/edit$/);
  await page.goBack();
  await details.getByRole("button", { name: "Resume" }).click();
  await expect
    .poll(() => lifecycle)
    .toEqual([{ action: "resume", revision: editor.value.revision }]);
  // A resumed Automation leaves the count, so the badge drops at once.
  await expect(badge).toHaveAccessibleName(`Inbox, ${waiting - 1} waiting`);
  await expect(details).toHaveCount(0);
});

test("the asks and Done load their next pages at the end of the list", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page, {
    open: [prReview, prMerge, prReady],
    pageSize: 1,
  });
  // No code changes, so the asks are the whole list and its end shows.
  await mockViewerCodeChanges(page, []);
  const cursors: string[] = [];
  page.on("request", (request) => {
    const cursor = new URL(request.url()).searchParams.get("cursor");
    if (request.url().includes("/api/review-items?") && cursor)
      cursors.push(cursor);
  });
  await page.goto(`${dashboard.baseURL}/?view=prs`);
  // Each PR is on its own page; the list loads the next as its end shows.
  await expect(
    page.locator("section[aria-label] section[aria-label]"),
  ).toHaveText([/^Waiting on you/, /^Waiting on others/]);
  await expect(page.getByText("Loading more…")).toHaveCount(0);

  await page
    .getByRole("navigation", { name: "Inbox" })
    .getByRole("link", { name: "Done", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /Digest skipped/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /initech license entry/ }),
  ).toBeVisible();
  expect(cursors).toEqual(expect.arrayContaining(["1", "2"]));
});

test("Pull requests sorts your open changes into Waiting on you and Waiting on others", async ({
  dashboard,
  page,
}) => {
  const actions = await mockReviewItems(page, { open: [prReview] });
  await mockViewerCodeChanges(page, [
    { idleDays: 0, number: 7, title: "Tune the retry backoff" },
    { idleDays: 10, number: 8, title: "Drop the legacy webhook" },
    // prReview asks the viewer to review this one.
    { idleDays: 1, number: 91, title: "Pin the release train" },
    {
      idleDays: 0,
      number: 9,
      state: "merged",
      title: "Rename the payments queue",
    },
  ]);
  await page.goto(`${dashboard.baseURL}/?view=prs`);
  await expect(
    page.locator("section[aria-label] section[aria-label]"),
  ).toHaveText([/^Waiting on you/, /^Waiting on others/]);
  const waiting = page
    .getByRole("region", { name: "Waiting on you" })
    .getByRole("listitem", { name: "Pin the release train" });
  await expect(
    waiting.getByRole("link", { name: "Pin the release train" }),
  ).toHaveAttribute("href", "https://github.com/getsentry/payments/pull/91");
  // The ask stays with its pull request.
  await expect(
    waiting.getByRole("link", { name: new RegExp(prReview.title) }),
  ).toBeVisible();
  // The rest wait on a reviewer, CI or Junior: newest activity first, so
  // the idle one comes last.
  await expect(
    page
      .getByRole("region", { name: "Waiting on others" })
      .getByRole("listitem"),
  ).toHaveText([/Tune the retry backoff/, /Drop the legacy webhook/]);
  await expect(page.getByText("Rename the payments queue")).toHaveCount(0);

  // The ask keeps its actions: Done closes it.
  await waiting
    .locator("[data-inbox-row]")
    .first()
    .getByRole("link")
    .first()
    .click();
  await waiting.getByRole("button", { name: "Done", exact: true }).click();
  await expect
    .poll(() => actions.map((action) => action.id))
    .toEqual([prReview.id]);
});

test("To do lists its rows while the count is pending or failed", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page, { open: [license] });
  const todo = page.getByRole("region", { name: "To do" });
  const row = todo.getByRole("link", { name: new RegExp(license.title) });
  // A failed count leaves the badge without a number, not To do empty.
  await page.route("**/api/review-items/count", (route) =>
    route.fulfill({ json: { error: "Failed" }, status: 500 }),
  );
  await page.goto(`${dashboard.baseURL}/`);
  await expect(row).toBeVisible();
  // A count that never answers does the same.
  await page.unroute("**/api/review-items/count");
  await page.route("**/api/review-items/count", () => undefined);
  await page.reload();
  await expect(row).toBeVisible();
});

test("a failed next page waits for Try again", async ({ dashboard, page }) => {
  await mockReviewItems(page, {
    open: [prReview, prMerge, prReady],
    pageSize: 1,
  });
  // No code changes, so the asks are the whole list and its end shows.
  await mockViewerCodeChanges(page, []);
  let attempts = 0;
  await page.route(/\/api\/review-items\?.*cursor=1(?:&|$)/, (route) => {
    attempts += 1;
    return attempts === 1
      ? route.fulfill({ json: { error: "Failed" }, status: 500 })
      : route.fallback();
  });
  await page.goto(`${dashboard.baseURL}/?view=prs`);
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(page.getByText("Could not load more.")).toBeVisible();
  // Two frames later, the list has not asked again on its own.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  expect(attempts).toBe(1);
  await retry.click();
  // The retried page loads, and the pages after it load on their own.
  await expect(
    page.locator("section[aria-label] section[aria-label]"),
  ).toHaveText([/^Waiting on you/, /^Waiting on others/]);
  await expect(retry).toHaveCount(0);
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
  await mockReviewItems(page, { automations: () => 0, open: [] });
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

test("To do loads its next asks at its own end", async ({
  dashboard,
  page,
}) => {
  // Each ask is in its own Conversation, so the stream below To do is long
  // and its end stays out of view.
  const asks = Array.from({ length: 30 }, (_, index) => ({
    ...license,
    addedByConversationId: `slack:CTODO:17700${String(index).padStart(5, "0")}.000100`,
    conversationIds: [],
    createdAt: new Date(NOW_MS - index * 60_000).toISOString(),
    id: `item-todo-${index}`,
    title: `Approve rollout step ${index}`,
  }));
  await mockReviewItems(page, { open: asks, pageSize: 10 });
  await page.goto(`${dashboard.baseURL}/`);
  const rows = page
    .getByRole("region", { name: "To do" })
    .locator("[data-inbox-row]");
  await expect(rows).toHaveCount(10);
  // Its end loads the next page while it shows fewer than its count.
  await expect(async () => {
    await rows.last().scrollIntoViewIfNeeded();
    await expect(rows).toHaveCount(30, { timeout: 1_000 });
  }).toPass();
});

test("a link into a collapsed To do opens it and its row", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page, { open: [rollout, license] });
  await page.goto(`${dashboard.baseURL}/`);
  const todo = page.getByRole("region", { name: "To do" });
  await todo.getByRole("button", { name: /^To do/ }).click();
  await expect(todo.locator("[data-inbox-row]")).toHaveCount(0);

  await page.goto(`${dashboard.baseURL}/?item=${rollout.id}`);
  const asks = todo.getByRole("region", { name: `${checkout}: asks` });
  await expect(asks).toContainText(rollout.title);
  await expect(asks).toBeInViewport();
  // The link leaves the URL only once its row is on screen.
  await expect(page).toHaveURL(`${dashboard.baseURL}/`);
});

test("To do lists every Automation that the count counts", async ({
  dashboard,
  page,
}) => {
  const base = automationReport.automations.find(
    (automation) => automation.id === "scheduled-1",
  )!;
  // More than one page of the Automation list.
  const report = {
    automations: Array.from({ length: 105 }, (_, index) => ({
      ...structuredClone(base),
      id: `blocked-${index}`,
      lastRunStatus: "blocked" as const,
      ownedByViewer: true,
      status: "blocked" as const,
      statusReason: "GitHub access expired.",
      title: `Blocked digest ${index}`,
    })),
  };
  await page.route(/\/api\/automations(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: mockAutomationCollection(
        report,
        new URL(route.request().url()).searchParams,
      ),
    }),
  );
  await mockReviewItems(page, { automations: () => 105, open: [] });
  await page.goto(`${dashboard.baseURL}/`);
  await expect(
    page
      .getByRole("region", { name: "To do" })
      .locator('[data-inbox-row^="automation:"]'),
  ).toHaveCount(105);
});

test("an open row's notice leaves Dismiss and its title to the row", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page, { open: [prReady] });
  await page.goto(`${dashboard.baseURL}/?view=prs&item=${prReady.id}`);
  const asks = page.getByRole("region", { name: /: asks$/ });
  const card = asks.getByRole("region", { name: prReady.title });
  await expect(card).toContainText("FYI");
  // The row's Done dismisses it, and the item row's head names it.
  await expect(asks.getByRole("button", { name: "Done" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
  await expect(card.getByRole("heading")).toHaveCount(0);

  // A Conversation row's head names the Conversation, so the ask keeps its
  // title.
  await page.goto(`${dashboard.baseURL}/?item=${prReady.id}`);
  await expect(
    page
      .getByRole("region", { name: /: asks$/ })
      .getByRole("heading", { name: prReady.title }),
  ).toBeVisible();
});

test("To do pages to its end when the count or the Automations fail", async ({
  dashboard,
  page,
}) => {
  const asks = Array.from({ length: 30 }, (_, index) => ({
    ...license,
    addedByConversationId: `slack:CTODO:17700${String(index).padStart(5, "0")}.000100`,
    conversationIds: [],
    createdAt: new Date(NOW_MS - index * 60_000).toISOString(),
    id: `item-todo-${index}`,
    title: `Approve rollout step ${index}`,
  }));
  await mockReviewItems(page, { open: asks, pageSize: 10 });
  // The count only feeds the badge, so its failure cannot stop To do.
  await page.route("**/api/review-items/count**", (route) =>
    route.fulfill({ json: { error: "Count failed" }, status: 500 }),
  );
  await page.route(/\/api\/automations\?scope=attention/, (route) =>
    route.fulfill({ json: { error: "Automations failed" }, status: 500 }),
  );
  await page.goto(`${dashboard.baseURL}/`);
  const rows = page
    .getByRole("region", { name: "To do" })
    .locator("[data-inbox-row]");
  await expect(rows).toHaveCount(10);
  await expect(async () => {
    await rows.last().scrollIntoViewIfNeeded();
    await expect(rows).toHaveCount(30, { timeout: 1_000 });
  }).toPass();
});

test("Done shows Try again when its first read fails", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page);
  let fail = true;
  await page.route(/\/api\/review-items\?.*status=done/, async (route) => {
    if (!fail) return route.fallback();
    fail = false;
    return route.fulfill({ json: { error: "Read failed" }, status: 500 });
  });
  await page.goto(`${dashboard.baseURL}/?view=done`);
  await expect(page.getByText("Could not load Done.")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("button", { name: new RegExp(answered.title) }),
  ).toBeVisible();
});

test("a snoozed row wakes at its time without a reload", async ({
  dashboard,
  page,
}) => {
  await page.clock.install({ time: NOW_MS });
  await mockReviewItems(page, { open: [license, rollout] });
  await page.goto(`${dashboard.baseURL}/`);
  const todo = page.getByRole("region", { name: "To do" });
  await rowHead(todo, checkout).click();
  await page.getByRole("button", { name: "Snooze" }).click();
  await page.getByRole("button", { name: "3 hours" }).click();
  await expect(rowHead(todo, checkout)).toHaveCount(0);
  await page.clock.fastForward("03:00:01");
  await expect(rowHead(todo, checkout)).toBeVisible();
});

test("an item row's second line names its subject, not its own title", async ({
  dashboard,
  page,
}) => {
  // The Conversation that added the item is not in the feed, and its title
  // does not load.
  await mockReviewItems(page, { open: [prReview] });
  await page.route(
    `**/api/conversations/${encodeURIComponent(prReview.addedByConversationId)}**`,
    (route) => route.fulfill({ json: { error: "Not found" }, status: 404 }),
  );
  await page.goto(`${dashboard.baseURL}/?view=prs`);
  const row = page
    .locator("[data-inbox-row]")
    .filter({ hasText: prReview.title });
  await expect(row).toContainText(prReview.subject.title);
  await expect(row.getByText(prReview.title, { exact: true })).toHaveCount(1);
});

test("an item's subject card hides when its text already shows that card", async ({
  dashboard,
  page,
}) => {
  // The release Conversation saved the card for this pull request.
  const item = {
    ...prReview,
    addedByConversationId: "slack:CQA456:1770021600.000600",
    body: "GitHub asks you to review this pull request.\n\nhttps://github.com/getsentry/payments/pull/91",
    id: "item-pr-card",
    kind: "notice" as const,
    request: undefined,
  };
  await mockReviewItems(page, { open: [item] });
  await page.goto(`${dashboard.baseURL}/?view=prs`);
  await rowHead(page, item.title).click();
  const card = page.getByRole("region", {
    name: "Pull request: Pin the release train to payments 4.2",
  });
  // The URL alone on its line shows the card in the text, so the subject
  // does not show it again.
  await expect(card.first()).toBeVisible();
  await expect(card).toHaveCount(1);
});
