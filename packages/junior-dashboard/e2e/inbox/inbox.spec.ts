import { mockAutomationCollection } from "../../src/mock-reporting/automation-collection";
import { NOW_MS } from "../../src/mock-reporting/fixtures";
import { mockAutomationEditor } from "../automation-editor-fixture";
import { automationReport } from "./automation-fixture";
import {
  automationAlert,
  answered,
  audit,
  digest,
  license,
  migration,
  mockInboxItems,
  mockViewerCodeChanges,
  prMerge,
  prReady,
  prReview,
  rollout,
  rowHead,
} from "./inbox-fixture";
import { screenshot } from "../screenshot";
import { expect, test } from "../test";

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  const checkout = "Investigate checkout latency";

  test("lists To do first, and the tab badge counts it", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page);
    await page.goto(`${dashboard.baseURL}/`);
    const todo = page.getByRole("region", { name: "To do" });
    // One row, or one stack of rows, per Conversation.
    await expect(
      todo.getByRole("link", { name: new RegExp(checkout) }),
    ).toBeVisible();
    // A Conversation with no title is named after its newest item.
    await expect(
      todo
        .locator("li[data-inbox-stack]")
        .getByRole("link", { name: new RegExp(audit.title) })
        .first(),
    ).toBeVisible();
    // The badge and To do count the same cards.
    const tab = page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: /^Inbox, \d+ waiting$/ });
    const badge = (await tab.getAttribute("aria-label"))!.replace(/\D/g, "");
    await expect(tab).toHaveText(new RegExp(`^Inbox\\s*${badge}$`));
    await expect(todo.getByText(badge, { exact: true })).toBeVisible();
    // The Inbox has no heading of its own, and closed items show only in Done.
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
    await expect(page.getByText(answered.title)).toHaveCount(0);
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
    await expect(todo.getByRole("list").first()).toBeVisible();
  });

  test("each entry lists its own rows under its name", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, {
      open: [rollout, license, audit, prReady, migration, prMerge, prReview],
    });
    await page.goto(`${dashboard.baseURL}/`);
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link")).toHaveText([
      /^Inbox/,
      /^Snoozed/,
      /^Done$/,
      /^Conversations$/,
      /^Automations/,
      new RegExp(checkout),
    ]);
    // A filter counts what waits on the viewer, like the badge: the
    // "Pull request ready for review" notice does not.
    await expect(
      page.getByRole("navigation", { name: "Asks to show" }).getByRole("link"),
    ).toHaveText([/^All\s*6$/, /^Pull requests\s*2$/, /^Decisions\s*4$/]);
    const sections = page.locator("section[aria-label] section[aria-label]");

    // Pull requests list the viewer's open changes, with their asks.
    await page.goto(`${dashboard.baseURL}/?view=prs`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Pull requests" }),
    ).toBeVisible();
    await expect(sections).toHaveText([
      /^Waiting on you/,
      /^Waiting on others/,
    ]);
    await screenshot(page, "inbox-pull-requests", { lightTheme: true });

    // Decisions group by Conversation, the longest wait first.
    await page.goto(`${dashboard.baseURL}/?view=decisions`);
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
        .locator("a[data-inbox-head]")
        .getByText(checkout, { exact: true }),
    ).toBeVisible();
    await screenshot(page, "inbox-conversations", { lightTheme: true });

    await nav.getByRole("link", { name: /^Automations/ }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Automations" }),
    ).toBeVisible();
    await screenshot(page, "inbox-automations", { lightTheme: true });
  });

  test("a row answers its ask in place", async ({ dashboard, page }) => {
    const actions = await mockInboxItems(page, {
      open: [rollout, license, audit],
    });
    await page.goto(`${dashboard.baseURL}/`);
    const todo = page.getByRole("region", { name: "To do" });
    // Each ask has its own row, in its stack or alone.
    const row = (item: { id: string }) =>
      todo.locator(`li[data-inbox-row="todo:${item.id}"]`);
    // A row click expands the row. The list stays where it is.
    await row(audit).locator("[data-inbox-head]").first().click();
    const asks = page.getByRole("region", { name: /: asks$/ });
    await expect(asks).toHaveCount(1);
    await expect(page).toHaveURL(`${dashboard.baseURL}/`);

    const auditItem = asks.locator("[data-inbox-card]");
    await auditItem.getByRole("radio", { name: "Reject" }).click();
    await auditItem.getByLabel("Anything else?").fill("Ask legal first.");
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

    // The license ask has its own form, so the audit's choice does not
    // carry over, and its Dismiss closes only its own item.
    await expect(
      todo.locator(`li[data-inbox-row="todo:${audit.id}"]`),
    ).toHaveCount(0);
    const licenseRow = row(license);
    const licenseItem = licenseRow.locator("[data-inbox-card]");
    // Next opens it: alone in its Conversation now, still in its own row.
    await expect(licenseRow).toHaveAttribute("data-expanded", "true");
    await expect(licenseItem).toBeVisible();
    await expect(
      licenseItem.getByRole("radio", { name: "Reject" }),
    ).not.toBeChecked();
    await licenseItem
      .getByRole("button", { name: "Dismiss", exact: true })
      .click();
    await expect
      .poll(() => actions.map((action) => action.id))
      .toEqual([audit.id, license.id]);
  });

  test("a sweep dismisses only FYI items, with an Undo", async ({
    dashboard,
    page,
  }) => {
    // Today is a calendar day, so the clock is fixed: on a real clock, half
    // an hour ago is yesterday just after midnight.
    await page.clock.setFixedTime(NOW_MS);
    // A question for Everyone is still a question, so a sweep leaves it.
    const teamAsk = {
      ...audit,
      owner: { id: "slack:C789:1770021600.000900", kind: "conversation" },
      rootConversationId: "slack:C789:1770021600.000900",
      assignedToEveryone: true,
      assignees: [],
      // Recent, so it shows in Today above the older Conversations.
      createdAt: new Date(NOW_MS - 30 * 60_000).toISOString(),
      id: "item-team-ask",
      title: "Pick the on-call rotation",
    };
    const actions = await mockInboxItems(page, {
      open: [license, prReady, digest, teamAsk],
    });
    await page.goto(`${dashboard.baseURL}/`);
    // FYI dismisses its notices and says so; the questions stay.
    await page.getByRole("button", { name: "Dismiss 2 in FYI" }).click();
    await expect(page.getByText("Dismissed 2 FYIs")).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Pick the on-call rotation/ }),
    ).toBeVisible();
    // The toast with Undo does not outlast a phone view as well.
    await screenshot(page, "inbox-sweep", {
      lightTheme: true,
      view: "desktop",
    });
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(
      page.getByRole("button", { name: "Dismiss 2 in FYI" }),
    ).toBeVisible();
    // Only section headers sweep. No label says "need you".
    const sweeps = page.getByRole("button", { name: /^Dismiss \d+ in / });
    await expect(sweeps).toHaveText(
      Array(await sweeps.count()).fill(/^Dismiss \d+$/),
    );
    await expect(page.getByText(/\bneeds? you\b/i)).toHaveCount(0);
    expect(actions).toEqual([]);

    // The sweep closes the items when the Undo window ends.
    await page.getByRole("button", { name: "Dismiss 2 in FYI" }).click();
    await expect
      .poll(() => actions.map((action) => action.id), { timeout: 10_000 })
      .toContain(digest.id);
    expect(actions.map((action) => action.id)).not.toContain(teamAsk.id);
  });

  test("Undo after a sweep works from an open Conversation and other tabs", async ({
    dashboard,
    page,
  }) => {
    await page.clock.setFixedTime(NOW_MS);
    const actions = await mockInboxItems(page, {
      open: [license, prReady, digest],
    });
    await page.goto(`${dashboard.baseURL}/`);
    const clearFyi = page.getByRole("button", {
      name: /^Dismiss \d+ in FYI$/,
    });
    await clearFyi.click();
    await expect(page.getByText(/^Dismissed \d+ FYIs?$/)).toBeVisible();
    await expect(clearFyi).toHaveCount(0);

    // The toast stays while a Conversation opens and while the Inbox leaves
    // the page, and its Undo still works.
    await page
      .getByRole("list", { name: "In flight" })
      .getByRole("link", { name: new RegExp(checkout) })
      .click();
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
    await expect(clearFyi).toBeVisible();
    expect(actions).toEqual([]);
  });

  test("a sweep that fails to close an item brings it back", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, {
      failActions: [digest.id],
      open: [license, digest],
    });
    await page.goto(`${dashboard.baseURL}/`);
    const digestFyi = page
      .getByRole("region", { name: "FYI" })
      .locator("[data-inbox-row]")
      .filter({ hasText: digest.title });
    await expect(digestFyi).toBeVisible();
    await page.getByRole("button", { name: /^Dismiss \d+ in FYI$/ }).click();
    await expect(digestFyi).toHaveCount(0);
    await expect(page.getByText(/^Could not dismiss \d+ FYIs?$/)).toBeVisible({
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
    // The Automation's alert in the Inbox. A resume closes it on the server.
    const open = [
      license,
      automationAlert("scheduled-1", "Weekly project summary"),
    ];
    await mockInboxItems(page, {
      automations: () =>
        mockAutomationCollection(
          report,
          new URLSearchParams({ owner: "me", scope: "attention" }),
        ).total,
      open,
    });
    const lifecycle: unknown[] = [];
    await page.route("**/api/automations/scheduled-1/lifecycle", (route) => {
      lifecycle.push(route.request().postDataJSON());
      open.pop();
      Object.assign(
        report.automations.find(
          (automation) => automation.id === "scheduled-1",
        )!,
        { lastRunStatus: "completed", status: "active", statusReason: null },
      );
      return route.fulfill({ json: { ...editor.value, status: "active" } });
    });
    const badge = page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: /^Inbox, \d+ waiting$/ });

    // The Automations page lists them first, as To do, with the Inbox's rows.
    await page.goto(`${dashboard.baseURL}/automations`);
    const todo = page.getByRole("region", { exact: true, name: "To do" });
    await todo.getByRole("button", { name: /Weekly project summary/ }).click();
    await expect(page).toHaveURL(/\/automations$/);
    const details = page.getByRole("region", {
      name: "Weekly project summary: attention",
    });
    // The header says why it is blocked, so the card does not say it again.
    await expect(
      todo.getByRole("button", { name: /Weekly project summary/ }),
    ).toContainText("Blocked · GitHub access expired.");
    await expect(details).not.toContainText("GitHub access expired.");
    await expect(details.getByText("Why", { exact: true })).toHaveCount(0);
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
    // A resume closes the alert, so the badge drops at once.
    await expect(badge).toHaveAccessibleName(`Inbox, ${waiting - 1} waiting`);
    await expect(details).toHaveCount(0);
  });

  test("Pull requests sorts your open changes into Waiting on you, Waiting on others and Drafts", async ({
    dashboard,
    page,
  }) => {
    const actions = await mockInboxItems(page, { open: [prReview] });
    await mockViewerCodeChanges(page, [
      {
        idleDays: 0,
        number: 7,
        size: { additions: 1204, changedFiles: 12, deletions: 340 },
        title: "Tune the retry backoff",
      },
      // GitHub counted no deletions here.
      {
        idleDays: 10,
        number: 8,
        size: { additions: 64, changedFiles: 2 },
        title: "Drop the legacy webhook",
      },
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
      waiting.getByRole("link", { exact: true, name: "Pin the release train" }),
    ).toHaveAttribute("href", "https://github.com/getsentry/payments/pull/91");
    // The ask stays with its pull request.
    await expect(waiting.locator("[data-inbox-head]")).toHaveAccessibleName(
      /^Review Pin the release train/,
    );
    // The rest wait on a reviewer, CI or Junior: newest activity first, so
    // the idle one comes last.
    await expect(
      page
        .getByRole("region", { name: "Waiting on others" })
        .getByRole("listitem"),
    ).toHaveText([/Tune the retry backoff/, /Drop the legacy webhook/]);
    // Each row gives its size, and leaves out a count it does not know.
    const others = page.getByRole("region", { name: "Waiting on others" });
    await expect(
      others.getByRole("listitem", { name: "Tune the retry backoff" }),
    ).toContainText("1,204 lines added, 340 removed, 12 files changed");
    const legacy = others.getByRole("listitem", {
      name: "Drop the legacy webhook",
    });
    await expect(legacy).toContainText("64 lines added, 2 files changed");
    await expect(legacy).not.toContainText("removed");
    await expect(page.getByText("Rename the payments queue")).toHaveCount(0);
    // A draft waits on its author, so it leaves the other piles. Drafts starts
    // collapsed.
    const drafts = page.getByRole("region", { name: "Drafts" });
    await expect(drafts.getByRole("listitem")).toHaveCount(0);
    await drafts.getByRole("button", { name: /Drafts/ }).click();
    await expect(drafts.getByRole("listitem")).toHaveText([
      /Sketch the replay/,
    ]);

    // The ask keeps its actions: Done closes it.
    await waiting
      .locator("[data-inbox-row]")
      .first()
      .getByRole("link")
      .first()
      .click();
    await waiting.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect
      .poll(() => actions.map((action) => action.id))
      .toEqual([prReview.id]);
  });

  test("Done lists closed items, and a row expands in place", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page);
    await page.goto(`${dashboard.baseURL}/`);
    await page
      .getByRole("navigation", { name: "Primary" })
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
    await mockInboxItems(page, { open: [audit, rollout], pageSize: 1 });
    await page.goto(`${dashboard.baseURL}/review?item=${rollout.id}`);
    await expect(page).toHaveURL(/\/\?view=inbox$/);
    await expect(
      page.getByRole("region", { name: `${checkout}: asks` }),
    ).toBeVisible();

    await page.goto(`${dashboard.baseURL}/review?bundle=prs`);
    await expect(page).toHaveURL(/\/\?view=prs$/);
    await page.goto(`${dashboard.baseURL}/review`);
    await expect(page).toHaveURL(`${dashboard.baseURL}/`);
    await page.goto(`${dashboard.baseURL}/inbox`);
    await expect(page).toHaveURL(`${dashboard.baseURL}/`);

    // A closed item opens in Done.
    await page.goto(`${dashboard.baseURL}/review?item=${answered.id}`);
    await expect(page).toHaveURL(/\/\?view=done$/);
    await expect(
      page.getByRole("region", { name: `${answered.title}: how it closed` }),
    ).toBeVisible();
  });

  test("a link into a collapsed To do opens it and its row", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, { open: [rollout, license] });
    await page.goto(`${dashboard.baseURL}/`);
    const todo = page.getByRole("region", { name: "To do" });
    await todo.getByRole("button", { name: /^To do/ }).click();
    await expect(todo.locator("[data-inbox-row]")).toHaveCount(0);

    await page.goto(`${dashboard.baseURL}/?item=${rollout.id}`);
    const asks = todo.getByRole("region", { name: `${checkout}: asks` });
    await expect(
      todo.locator(`li[data-inbox-row="todo:${rollout.id}"]`),
    ).toHaveAttribute("data-expanded", "true");
    await expect(asks).toBeInViewport();
    // The link leaves the URL only once its row is on screen.
    await expect(page).toHaveURL(`${dashboard.baseURL}/`);
  });

  test("each card of an open row keeps its own Dismiss, and an item row's head names it", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, { open: [prReady, license, audit] });
    await page.goto(`${dashboard.baseURL}/?view=prs&item=${prReady.id}`);
    const asks = page.getByRole("region", { name: /: asks$/ });
    const card = asks.getByRole("region", { name: prReady.title });
    // The card's Dismiss closes it. The item row's head names it and its
    // kind, so the card says neither again.
    await expect(card).not.toContainText("FYI");
    await expect(
      card.getByRole("button", { exact: true, name: "Dismiss" }),
    ).toBeVisible();
    await expect(card.getByRole("heading")).toHaveCount(0);

    // A Conversation row's head names the Conversation, so the ask keeps its
    // title. In the Inbox, these asks stack as rows; Conversations keeps the
    // Conversation row.
    await page.goto(
      `${dashboard.baseURL}/?view=conversations&item=${prReady.id}`,
    );
    await expect(
      page
        .getByRole("region", { name: /: asks$/ })
        .getByRole("heading", { name: prReady.title }),
    ).toBeVisible();

    // Each question keeps its own Dismiss beside its Send, and the row's
    // bar has none.
    const row = page.getByRole("region", { name: /: asks$/ });
    for (const question of [license, audit]) {
      const card = row.getByRole("region", { name: question.title });
      await expect(card.getByRole("button", { name: "Send" })).toBeVisible();
      await expect(
        card.getByRole("button", { exact: true, name: "Dismiss" }),
      ).toHaveCount(1);
    }
    await expect(
      row.getByRole("button", { name: "Dismiss", exact: true }),
    ).toHaveCount(3);
  });

  test("a code change row's head names its subject, not its own title", async ({
    dashboard,
    page,
  }) => {
    // The Conversation that added the item is not in the feed, and its title
    // does not load.
    await mockInboxItems(page, { open: [prReview] });
    await page.route(
      `**/api/conversations/${encodeURIComponent(prReview.owner.id)}**`,
      (route) => route.fulfill({ json: { error: "Not found" }, status: 404 }),
    );
    await page.goto(`${dashboard.baseURL}/?view=prs`);
    const row = page
      .locator("[data-inbox-row]")
      .filter({ hasText: prReview.subject.title });
    // The head leads with the subject's title, so the second line does not
    // say it again.
    await expect(
      row.getByText(prReview.subject.title, { exact: true }),
    ).toHaveCount(0);
    await expect(row.locator("[data-code-change-title]")).toContainText(
      prReview.subject.title,
    );
    await expect(row).not.toContainText(prReview.title);
  });

  test("an item's text clamps only its prose, and its cards show in full", async ({
    dashboard,
    page,
  }) => {
    const card = "Pull request: Pin the release train to payments 4.2";
    const item = {
      ...prReview,
      owner: { id: "slack:CQA456:1770021600.000600", kind: "conversation" },
      rootConversationId: "slack:CQA456:1770021600.000600",
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
    await mockInboxItems(page, { open: [item] });
    await page.goto(`${dashboard.baseURL}/?view=prs`);
    await rowHead(page, "Pin the release train").click();
    const toggle = page.getByRole("button", { name: `Expand ${item.title}` });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const clamp = page.locator(
      `[id="${await toggle.getAttribute("aria-controls")}"]`,
    );
    await expect(clamp).toContainText("Release note 1");
    // The card is not part of the clamped prose, and only one shows.
    await expect(clamp.getByRole("region", { name: card })).toHaveCount(0);
    await expect(page.getByRole("region", { name: card })).toHaveCount(1);
    // In full means nothing clips it once it is scrolled to. On a slow CI
    // runner the list can still move after one scroll, so scroll again
    // until the card shows.
    await expect(async () => {
      await page.getByRole("region", { name: card }).scrollIntoViewIfNeeded();
      await expect(page.getByRole("region", { name: card })).toBeInViewport({
        ratio: 1,
        timeout: 1000,
      });
    }).toPass();
  });

  test("an item's subject card hides when its text already shows that card", async ({
    dashboard,
    page,
  }) => {
    // The release Conversation saved the card for this pull request.
    const item = {
      ...prReview,
      owner: { id: "slack:CQA456:1770021600.000600", kind: "conversation" },
      rootConversationId: "slack:CQA456:1770021600.000600",
      body: "GitHub asks you to review this pull request.\n\nhttps://github.com/getsentry/payments/pull/91",
      id: "item-pr-card",
      kind: "notice" as const,
      request: undefined,
    };
    await mockInboxItems(page, { open: [item] });
    await page.goto(`${dashboard.baseURL}/?view=prs`);
    await rowHead(page, "Pin the release train").click();
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
    // Two fields, so the question has a form that ends with Send.
    const asked = {
      ...rollout,
      addedByTurnId: turnId,
      request: {
        ...rollout.request,
        fields: [
          ...rollout.request.fields,
          { id: "note", kind: "text", label: "Rollout note" },
        ],
      },
    };
    await mockInboxItems(page, { open: [asked] });
    const event = (seq: number, data: Record<string, unknown>) => ({
      createdAt: new Date(NOW_MS - (60 - seq) * 1000).toISOString(),
      data,
      seq,
    });
    const reply = [
      "The canary error rate is flat for 30 minutes, <@U0MOCKADA>.",
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
            {
              ...event(4, {
                messageId: "m-reply",
                role: "assistant",
                text: reply,
                type: "message",
              }),
              mentions: [
                { fullName: "Ada Lovelace", slackUserId: "U0MOCKADA" },
              ],
            },
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
    // The message names the person it mentions, as the transcript does.
    await expect(message).toContainText("Ada Lovelace");
    await expect(message).not.toContainText("U0MOCKADA");
    // The question comes first, right under its label, then Junior's
    // message, then the form, which ends with Send on the right.
    const ask = page.locator("[data-inbox-item]").filter({ has: message });
    const send = ask.getByRole("button", { name: "Send" });
    const order = await ask.evaluate((section, asked) => {
      const at = (node: Element | null) =>
        node ? [...section.querySelectorAll("*")].indexOf(node) : -1;
      const question = [...section.querySelectorAll("div")].find(
        (node) => node.textContent?.trim() === asked,
      );
      const form = section.querySelector("form");
      const buttons = [...(form?.querySelectorAll("button") ?? [])];
      return {
        last: buttons.at(-1)?.textContent?.trim(),
        message: at(section.querySelector('[aria-label="Junior\'s message"]')),
        question: at(question ?? null),
        form: at(form),
      };
    }, asked.request.question);
    expect(order.question).toBeGreaterThanOrEqual(0);
    expect(order.question).toBeLessThan(order.message);
    expect(order.message).toBeLessThan(order.form);
    expect(order.last).toBe("Send");
    await expect(send).toBeVisible();
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
    // so the page keeps working. An item row has no Pin: the Conversations
    // view pins its Conversation.
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: /^Conversations/ })
      .click();
    const conversationRow = page.locator(
      `li[data-inbox-row="conversation:${rollout.rootConversationId}"]`,
    );
    await conversationRow.hover();
    await conversationRow.getByRole("button", { name: /^Pin / }).click();
    await expect(
      conversationRow.getByRole("button", { name: /^Unpin / }),
    ).toBeVisible();
    // Back, the row is still open, and its message reads from the cache.
    await page.goBack();
    await expect(message).toContainText("The canary error rate is flat");
    expect(reads).toBe(1);
  });

  test("cards grow near the pointer in both densities, except for reduced motion", async ({
    dashboard,
    page,
  }) => {
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    await page.evaluate(() => {
      localStorage.setItem("junior:density", "comfortable");
      // The magnifier is off until the viewer turns it on.
      localStorage.setItem("junior:inbox:magnify", "true");
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    const card = page.locator("[data-inbox-row]").first();
    await card.hover();
    // Let a frame pass, so a scale that was going to apply has applied.
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(done)),
    );
    await expect(card).not.toHaveAttribute("style", /scale/);

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.mouse.move(0, 0);
    await card.hover();
    // Up to 5% under the pointer, less for a neighbor.
    await expect(card).toHaveAttribute("style", /scale\(1\.0[1-5]/);
    await page.mouse.move(0, 0);
    await expect(card).not.toHaveAttribute("style", /scale/);

    // Compact rows grow too, up to 2%.
    await page.evaluate(() => {
      localStorage.setItem("junior:density", "compact");
    });
    await page.reload();
    await card.hover();
    await expect(card).toHaveAttribute("style", /scale\(1\.0[0-2]/);
  });

  test("an open ask holds its pull request still under the pointer", async ({
    dashboard,
    page,
  }) => {
    // Both changes wait on the viewer, so they share one list.
    await mockInboxItems(page, { open: [prReview, prMerge] });
    await mockViewerCodeChanges(page, [
      { idleDays: 1, number: 91, title: "Pin the release train" },
      { idleDays: 0, number: 42, title: "Tune the retry backoff" },
    ]);
    await page.addInitScript(() => {
      localStorage.setItem("junior:density", "comfortable");
      localStorage.setItem("junior:inbox:magnify", "true");
    });
    await page.goto(`${dashboard.baseURL}/?view=prs`);
    const change = page.getByRole("listitem", {
      name: "Pin the release train",
    });
    await change.locator("[data-inbox-head]").click();
    await expect(change.locator("[data-expanded]")).toHaveCount(1);
    await page.mouse.move(0, 0);
    await change.hover();
    // The other change still grows, so the pointer counts.
    await expect(
      page.getByRole("listitem", { name: "Tune the retry backoff" }),
    ).toHaveAttribute("style", /scale/);
    await expect(change).not.toHaveAttribute("style", /scale/);
  });
});
