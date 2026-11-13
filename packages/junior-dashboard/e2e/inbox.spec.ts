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
  // An entry counts what waits on the viewer, like the badge: the
  // "Pull request ready for review" notice does not.
  await expect(nav.getByRole("link")).toHaveText([
    /^Inbox/,
    /^Snoozed/,
    /^Done$/,
    /^Conversations$/,
    /^Pull requests\s*2$/,
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
  // The row's own link; its summary can link the same Conversation.
  await expect(
    page
      .getByRole("region", { name: "Today" })
      .locator('a[aria-controls^="inbox-row-"]')
      .getByText(checkout, { exact: true }),
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

test("Undo after a Clear works from an open Conversation and other tabs", async ({
  dashboard,
  page,
}) => {
  await page.clock.setFixedTime(NOW_MS);
  const actions = await mockReviewItems(page, {
    open: [license, prReady, digest],
  });
  await page.goto(`${dashboard.baseURL}/`);
  const clearToday = page.getByRole("button", { name: /^Clear \d+ in Today$/ });
  await clearToday.click();
  await expect(page.getByText(/^Cleared \d+ items?$/)).toBeVisible();
  await expect(clearToday).toHaveCount(0);

  // The toast stays while a Conversation opens and while the Inbox leaves
  // the page, and its Undo still works.
  const row = page
    .locator("[data-inbox-row]")
    .filter({ hasText: checkout })
    .first();
  await row.hover();
  await row.getByRole("link", { name: "Open conversation" }).first().click();
  await expect(page).toHaveURL(/\/conversations\//);
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: /^Automations/ })
    .click();
  await expect(page).toHaveURL(/\/automations/);
  await page.getByRole("button", { name: "Undo" }).click();
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(`${dashboard.baseURL}/`);
  await expect(clearToday).toBeVisible();
  expect(actions).toEqual([]);
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

test("Pull requests sorts your open changes into Waiting on you, Waiting on others and Drafts", async ({
  dashboard,
  page,
}) => {
  const actions = await mockReviewItems(page, { open: [prReview] });
  await mockViewerCodeChanges(page, [
    { idleDays: 0, number: 7, title: "Tune the retry backoff" },
    { idleDays: 10, number: 8, title: "Drop the legacy webhook" },
    // prReview asks the viewer to review this one.
    { idleDays: 1, number: 91, title: "Pin the release train" },
    { draft: true, idleDays: 0, number: 15, title: "Sketch the replay" },
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
  ).toHaveText([/^Waiting on you/, /^Waiting on others/, /^Drafts/]);
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
  // A draft waits on its author, so it leaves the other piles. Drafts starts
  // collapsed.
  const drafts = page.getByRole("region", { name: "Drafts" });
  await expect(drafts.getByRole("listitem")).toHaveCount(0);
  await drafts.getByRole("button", { name: /Drafts/ }).click();
  await expect(drafts.getByRole("listitem")).toHaveText([/Sketch the replay/]);

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

test("an item's text clamps only its prose, and its cards show in full", async ({
  dashboard,
  page,
}) => {
  const card = "Pull request: Pin the release train to payments 4.2";
  const item = {
    ...prReview,
    addedByConversationId: "slack:CQA456:1770021600.000600",
    body: [
      "GitHub asks you to review this pull request.",
      "https://github.com/getsentry/payments/pull/91",
      ...Array.from(
        { length: 6 },
        (_, index) => `Release note ${index + 1}: the train pins payments.`,
      ),
    ].join("\n\n"),
    id: "item-pr-card-clamp",
    kind: "notice" as const,
    request: undefined,
  };
  await mockReviewItems(page, { open: [item] });
  await page.goto(`${dashboard.baseURL}/?view=prs`);
  await rowHead(page, item.title).click();
  const toggle = page.getByRole("button", { name: `Expand ${item.title}` });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const clamp = page.locator(
    `[id="${await toggle.getAttribute("aria-controls")}"]`,
  );
  await expect(clamp).toContainText("Release note 1");
  // The card is not part of the clamped prose, and only one shows.
  await expect(clamp.getByRole("region", { name: card })).toHaveCount(0);
  await expect(page.getByRole("region", { name: card })).toHaveCount(1);
  await page.getByRole("region", { name: card }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("region", { name: card })).toBeInViewport({
    ratio: 1,
  });
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

test("an expanded question shows the message of the Turn that asked it", async ({
  dashboard,
  page,
}) => {
  const turnId = "turn-rollout";
  await mockReviewItems(page, {
    open: [{ ...rollout, addedByTurnId: turnId }],
  });
  const event = (seq: number, data: Record<string, unknown>) => ({
    createdAt: new Date(NOW_MS - (60 - seq) * 1000).toISOString(),
    data,
    seq,
  });
  const reply = [
    "The canary error rate is flat for 30 minutes.",
    ...Array.from({ length: 8 }, (_, index) => `Region ${index + 1} holds.`),
    "Roll out when ready.",
  ].join("\n\n");
  let reads = 0;
  await page.route("**/api/conversations/*/events?*", (route) => {
    if (new URL(route.request().url()).searchParams.get("turn") !== turnId) {
      return route.fallback();
    }
    reads += 1;
    return route.fulfill({
      json: {
        eventHistory: { status: "available" },
        events: [
          event(1, {
            messageId: "m-before",
            role: "assistant",
            text: "An older Turn's reply.",
            type: "message",
          }),
          event(2, { state: "started", turnId, type: "turn_lifecycle" }),
          event(3, {
            messageId: "m-check",
            role: "assistant",
            text: "Checking the canary first.",
            type: "message",
          }),
          event(4, {
            messageId: "m-reply",
            role: "assistant",
            text: reply,
            type: "message",
          }),
          event(5, { state: "succeeded", turnId, type: "turn_lifecycle" }),
          event(6, {
            state: "started",
            turnId: "turn-later",
            type: "turn_lifecycle",
          }),
          event(7, {
            messageId: "m-later",
            role: "assistant",
            text: "A later Turn's reply.",
            type: "message",
          }),
        ],
        generatedAt: new Date(NOW_MS).toISOString(),
      },
    });
  });
  await page.goto(`${dashboard.baseURL}/?view=decisions`);
  const head = rowHead(page, rollout.title);
  await expect(head).toBeVisible();
  // Nothing loads until the row expands.
  expect(reads).toBe(0);
  await head.click();
  const message = page.getByRole("region", { name: "Junior's message" });
  await expect(message).toContainText("The canary error rate is flat");
  await expect(message).not.toContainText("Checking the canary first.");
  await expect(message).not.toContainText("Turn's reply");
  // Long messages clamp, and the toggle opens the rest.
  const toggle = message.getByRole("button", {
    name: "Expand Junior's message",
  });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(
    message.getByRole("button", { name: "Collapse Junior's message" }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(message.getByText("Roll out when ready.")).toBeInViewport();
  expect(reads).toBe(1);
  // A pin updates every cached feed. The Turn's message is not one of them,
  // so the page keeps working.
  await page.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Unpin", exact: true }),
  ).toBeVisible();
  await expect(message).toBeVisible();
});

test("comfortable rows show cards for message links that name an object", async ({
  dashboard,
  page,
}) => {
  const person = `${dashboard.baseURL}/people/dev%40example.com`;
  const unknown = "https://example.com/no-card";
  // The feed lists the links from this row's messages.
  await page.route(
    (url) => url.pathname === "/api/conversations",
    async (route) => {
      const response = await route.fetch();
      const feed = (await response.json()) as {
        conversations: Array<{ displayTitle: string; links?: string[] }>;
      };
      for (const row of feed.conversations) {
        if (row.displayTitle === "Investigate checkout latency") {
          row.links = [person, unknown];
        }
      }
      await route.fulfill({ json: feed, response });
    },
  );
  await page.goto(`${dashboard.baseURL}/?view=conversations`);
  await page.evaluate(() => {
    localStorage.setItem("junior:density", "comfortable");
  });
  await page.reload();
  const row = page
    .locator("[data-inbox-row]")
    .filter({ hasText: "Investigate checkout latency" })
    .first();
  const links = row.getByRole("group", { name: "Links" });
  // The person link resolves to a card; the other link names nothing and
  // shows nothing, not a bare link.
  await expect(links.getByRole("link")).toHaveCount(1);
  await expect(links.getByRole("link")).toHaveAttribute("href", person);
  await expect(row.locator(`a[href="${unknown}"]`)).toHaveCount(0);
});

test("comfortable rows show files and linked work as cards, and compact rows keep chips", async ({
  dashboard,
  page,
}) => {
  const density = async (value: "comfortable" | "compact") => {
    await page.evaluate((next) => {
      localStorage.setItem("junior:density", next);
    }, value);
    await page.reload();
  };
  await page.goto(`${dashboard.baseURL}/?view=conversations`);
  await density("comfortable");
  const release = page
    .locator("[data-inbox-row]")
    .filter({ hasText: "Package release and self-update" })
    .first();
  const work = release.getByRole("group", { name: "Linked work" });
  // Newest first, each with its title and status.
  await expect(work.getByRole("link")).toHaveText([
    /Update Junior to 0\.288\.0.*getsentry\/junior#2201 · Draft/,
    /Pin the release train to payments 4\.2.*getsentry\/payments#91 · Open/,
    /Return 429 before parsing oversized envelopes.*getsentry\/relay#44 · Merged/,
  ]);
  // Quiet cards: no icon, and a line in each one's status color.
  const cards = work.locator("[data-linked-work-card]");
  await expect(cards.locator("svg")).toHaveCount(0);
  await expect
    .poll(() =>
      cards
        .locator("[data-status-tone]")
        .evaluateAll((lines) =>
          lines.map((line) => line.getAttribute("data-status-tone")),
        ),
    )
    .toEqual(["neutral", "success", "accent"]);
  await expect(
    work.getByRole("link", { name: /Pin the release train/ }),
  ).toHaveAttribute("href", "https://github.com/getsentry/payments/pull/91");
  // Work saved without a title keeps its chip.
  const qa = page
    .locator("[data-inbox-row]")
    .filter({ hasText: "Dashboard QA edge cases" })
    .first();
  await expect(qa.getByRole("group", { name: "Linked work" })).toBeAttached();
  await expect(qa.getByRole("link", { name: /getsentry/ })).toHaveCount(0);
  await expect(qa.getByLabel(/^Linked work, newest first/)).toBeAttached();
  // Its newest files: images as lazy thumbnails, other files by name.
  const files = qa.getByRole("group", { name: "Files" });
  await expect(files.getByRole("link")).toHaveCount(3);
  for (const name of ["chart.png", "chart-detail.png"]) {
    const thumbnail = files.getByRole("img", { name, exact: true });
    await expect(thumbnail).toHaveAttribute("loading", "lazy");
    await expect(thumbnail).toHaveAttribute(
      "src",
      /\/attachments\/qa-chart-png$/,
    );
  }
  await expect(files.getByRole("link", { name: "demo.mp4" })).toBeAttached();
  // A pull request card shows the first image of its description.
  const preview = page
    .locator("[data-inbox-row]")
    .filter({ hasText: "Investigate checkout latency" })
    .first()
    .getByRole("img", {
      name: "Preview of Retry checkout writes after lock timeouts",
    });
  // The mock serves the preview itself.
  await expect(preview).toHaveAttribute("src", /\/api\/images\/checkout-p95$/);
  await preview.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      preview.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);

  await density("compact");
  await expect(qa.getByRole("group", { name: "Files" })).toHaveCount(0);
  // Compact rows name each piece of work by its title and number, in its
  // status color, on one line.
  await expect(release.locator("[data-linked-work-card]")).toHaveCount(0);
  const chips = release.locator("[data-linked-work-chip]");
  await expect(chips.first()).toHaveText("Update Junior to 0.288.0#2201");
  await expect(chips.first().locator("[data-status-tone]")).toHaveAttribute(
    "data-status-tone",
    "neutral",
  );
});

test("a linked-work preview that fails to load leaves no empty box", async ({
  dashboard,
  page,
}) => {
  await page.route("**/api/images/checkout-p95", (route) =>
    route.fulfill({ status: 404 }),
  );
  await page.addInitScript(() =>
    localStorage.setItem("junior:density", "comfortable"),
  );
  await page.goto(`${dashboard.baseURL}/?view=conversations`);
  const card = page
    .locator("[data-inbox-row]")
    .filter({ hasText: checkout })
    .first()
    .locator("[data-linked-work-card]")
    .filter({ hasText: "Retry checkout writes after lock timeouts" });
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();
  await expect(card.getByRole("img")).toHaveCount(0);
});

test("comfortable cards grow near the pointer, except for reduced motion", async ({
  dashboard,
  page,
}) => {
  await page.goto(`${dashboard.baseURL}/?view=conversations`);
  await page.evaluate(() => {
    localStorage.setItem("junior:density", "comfortable");
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  const card = page.locator("[data-inbox-row]").first();
  await card.hover();
  // Let a frame pass, so a scale that was going to apply has applied.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
  await expect(card).not.toHaveAttribute("style", /scale/);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.mouse.move(0, 0);
  await card.hover();
  // Up to 5% under the pointer, less for a neighbor.
  await expect(card).toHaveAttribute("style", /scale\(1\.0[1-5]/);
  await page.mouse.move(0, 0);
  await expect(card).not.toHaveAttribute("style", /scale/);

  // Compact rows hold still.
  await page.evaluate(() => {
    localStorage.setItem("junior:density", "compact");
  });
  await page.reload();
  await card.hover();
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
  await expect(card).not.toHaveAttribute("style", /scale/);
});

test("an open ask holds its pull request still under the pointer", async ({
  dashboard,
  page,
}) => {
  // Both changes wait on the viewer, so they share one list.
  await mockReviewItems(page, { open: [prReview, prMerge] });
  await mockViewerCodeChanges(page, [
    { idleDays: 1, number: 91, title: "Pin the release train" },
    { idleDays: 0, number: 42, title: "Tune the retry backoff" },
  ]);
  await page.addInitScript(() =>
    localStorage.setItem("junior:density", "comfortable"),
  );
  await page.goto(`${dashboard.baseURL}/?view=prs`);
  const change = page.getByRole("listitem", { name: "Pin the release train" });
  await change.getByRole("link", { name: new RegExp(prReview.title) }).click();
  await expect(change.locator("[data-expanded]")).toHaveCount(1);
  await page.mouse.move(0, 0);
  await change.hover();
  // The other change still grows, so the pointer counts.
  await expect(
    page.getByRole("listitem", { name: "Tune the retry backoff" }),
  ).toHaveAttribute("style", /scale/);
  await expect(change).not.toHaveAttribute("style", /scale/);
});
