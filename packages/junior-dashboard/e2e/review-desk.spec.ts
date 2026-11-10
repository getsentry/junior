import { CONVERSATION_DETAIL_VERSION_HEADER } from "@sentry/junior/api/schema";
import type { Page } from "@playwright/test";
import { mockAutomationCollection } from "../src/mock-reporting/automation-collection";
import { mockAutomationEditor } from "./automation-editor-fixture";
import { automationReport } from "./automation-fixture";
import { screenshot } from "./screenshot";
import { expect, test } from "./test";

const viewer = {
  displayName: "Dashboard User",
  email: "dev@example.com",
  userId: "u-dev",
};

const base = {
  addedByConversationId: "slack:CREVIEW:1770003600.000200",
  assignedToEveryone: false,
  assignees: [viewer],
  canAct: true,
  canTake: false,
  conversationIds: [],
  createdAt: "2026-08-07T08:00:00.000Z",
  kind: "action" as const,
  status: "open" as const,
  updatedAt: "2026-08-07T08:30:00.000Z",
  visibility: "public" as const,
};

const conversationId = "slack:CQA123:1770003600.000200";

// Added between messages of the mock Conversation, so the inbox shows the
// messages before it and a new one after it.
const rollout = {
  ...base,
  addedByConversationId: conversationId,
  body: "Canary error rate is flat.",
  createdAt: "2026-08-07T11:54:30.000Z",
  id: "item-rollout",
  request: {
    question: "Roll out payments-v42?",
    fields: [
      {
        id: "go",
        kind: "choice",
        label: "Rollout",
        options: [{ label: "Roll out" }, { label: "Hold" }],
      },
    ],
  },
  title: "Approve the payments-v42 rollout",
};

const license = {
  ...base,
  body: "The acme entry changed its license.",
  id: "item-license",
  request: {
    question: "Does acme still meet the definition?",
    fields: [
      {
        id: "decision",
        kind: "choice",
        label: "Decision",
        options: [{ label: "Approve" }, { label: "Reject" }],
      },
      { id: "reason", kind: "text", label: "Reason" },
    ],
  },
  title: "Review the acme license entry",
};

const audit = {
  ...license,
  createdAt: "2026-08-07T09:10:00.000Z",
  id: "item-audit",
  title: "Review the globex license entry",
};

const prReady = {
  ...base,
  body: "Junior opened a pull request for the payments retry fix.",
  id: "item-pr-ready",
  kind: "notice" as const,
  subject: {
    id: "acme/payments#42",
    title: "fix(payments): Retry declined webhooks",
    url: "https://github.com/acme/payments/pull/42",
  },
  title: "Pull request ready for review",
};

const answered = {
  ...license,
  answer: {
    requestId: "request-initech",
    values: { decision: ["Approve"], reason: ["MIT license, no change."] },
  },
  body: "The initech entry changed its license.",
  closedAt: "2026-08-07T09:40:00.000Z",
  createdAt: "2026-08-07T09:30:00.000Z",
  closedBy: viewer,
  id: "item-initech",
  status: "done" as const,
  title: "Review the initech license entry",
};

// The agent added this item in the Conversation, so a message there closes it.
const migration = {
  ...license,
  addedByConversationId: conversationId,
  body: "The billing migration is ready.",
  conversationIds: [conversationId],
  createdAt: "2026-08-07T10:20:00.000Z",
  id: "item-migration",
  title: "Pick the billing migration window",
};

// The GitHub plugin's ask for a Junior pull request: an action item with no
// question. The mock Conversation has the object annotation for the same URL.
const prMerge = {
  ...base,
  addedByConversationId: conversationId,
  body: "**Retry checkout writes after lock timeouts** is approved, and GitHub says that it can merge.",
  conversationIds: [conversationId],
  createdAt: "2026-08-07T11:00:00.000Z",
  id: "item-pr-merge",
  kind: "action" as const,
  subject: {
    id: "https://github.com/getsentry/payments/pull/42",
    title: "getsentry/payments#42",
    url: "https://github.com/getsentry/payments/pull/42",
  },
  title: "Ready to merge · #42",
};

// A second GitHub ask, so pull requests group by state.
const prReview = {
  ...prMerge,
  addedByConversationId: "slack:CREVIEW:1770003600.000200",
  body: "GitHub asks you to review **Pin the release train**.",
  conversationIds: [],
  createdAt: "2026-08-07T09:00:00.000Z",
  id: "item-pr-review",
  subject: {
    id: "https://github.com/getsentry/payments/pull/91",
    title: "getsentry/payments#91",
    url: "https://github.com/getsentry/payments/pull/91",
  },
  title: "Review requested · #91",
};

// A notice for Everyone in another Conversation: FYI, so a sweep clears it.
const digest = {
  ...base,
  addedByConversationId: "scheduler:daily-ops-digest",
  assignedToEveryone: true,
  assignees: [],
  body: "The digest skipped two noisy alerts.",
  createdAt: "2026-08-07T07:00:00.000Z",
  id: "item-digest",
  kind: "notice" as const,
  title: "Digest skipped two noisy alerts",
};

/**
 * Serve the given open items and the archived one. An answer or dismiss
 * closes the item, as on the server, so the inbox can move on. `keepOpen`
 * keeps an answered item open, so a test can answer it twice.
 */
async function mockReviewItems(
  page: Page,
  options: { keepOpen?: boolean; open?: unknown[]; pageSize?: number } = {},
) {
  const actions: { body: unknown; id: string }[] = [];
  let open = (options.open ?? [
    rollout,
    license,
    audit,
    prReady,
    migration,
  ]) as (typeof license)[];
  const archived = [answered];
  await page.route("**/api/review-items**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api\/review-items/, "");
    if (path === "/count") return route.fulfill({ json: { needsViewer: 3 } });
    if (path === "" || path === "/") {
      const q = url.searchParams.get("q")?.toLowerCase() ?? "";
      const linked = url.searchParams.get("conversationId");
      // A search also finds archived items, after the open ones.
      const list = (q ? [...open, ...archived] : open).filter(
        (i) =>
          i.title.toLowerCase().includes(q) &&
          (!linked || i.conversationIds.includes(linked)),
      );
      // The cursor is the index of the first item of the page.
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const end = start + (options.pageSize ?? list.length);
      return route.fulfill({
        json: {
          items: list.slice(start, end),
          ...(end < list.length ? { nextCursor: String(end) } : undefined),
        },
      });
    }
    const action = path.match(/^\/([^/]+)\/actions$/);
    if (action) {
      const id = decodeURIComponent(action[1]!);
      const item = open.find((i) => i.id === id);
      actions.push({ body: route.request().postDataJSON(), id });
      if (options.keepOpen) return route.fulfill({ json: item });
      open = open.filter((i) => i.id !== id);
      return route.fulfill({ json: { ...item, status: "done" } });
    }
    const item = [...open, ...archived].find(
      (i) => i.id === decodeURIComponent(path.slice(1)),
    );
    return item
      ? route.fulfill({ json: item })
      : route.fulfill({ json: { error: "Not found" }, status: 404 });
  });
  return actions;
}

test("the inbox bundles review items by conversation", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page);
  await page.goto(`${dashboard.baseURL}/review`);
  const todo = page.getByRole("region", { name: "To do" });
  const bundles = todo.getByRole("button", { expanded: false });
  // One bundle per Conversation. The one that waited longest comes first.
  await expect(bundles).toHaveCount(2);
  await expect(bundles.nth(0)).toContainText(audit.title);
  await expect(bundles.nth(0)).toContainText("2 questions");
  await expect(bundles.nth(1)).toContainText("Investigate checkout latency");
  await expect(bundles.nth(1)).toContainText(rollout.title);
  // Archived items show only in a search.
  await expect(page.getByText(answered.title)).toHaveCount(0);
  await screenshot(page, "review-desk", { lightTheme: true, view: "desktop" });

  // j shows where the reader is, and Enter opens the bundle in place.
  await page.keyboard.press("j");
  await expect(bundles.nth(0)).toBeFocused();
  await page.keyboard.press("Enter");
  const bundle = page.getByRole("region", {
    name: `${audit.title}: review items`,
  });
  await expect(
    bundle.getByRole("region", { name: license.title }),
  ).toBeVisible();
  await expect(bundle.getByRole("region", { name: audit.title })).toBeVisible();
  // Without its object card, a notice links to its subject.
  await expect(
    bundle.getByRole("link", { name: prReady.subject.title }),
  ).toBeVisible();
  await screenshot(page, "review-desk-bundle", {
    lightTheme: true,
    view: "desktop",
  });
  await page.keyboard.press("Escape");
  await expect(bundle).toBeHidden();

  await page.keyboard.press("j");
  await page.keyboard.press("Enter");
  const checkout = page.getByRole("region", {
    name: "Investigate checkout latency: review items",
  });
  await expect(checkout.getByText("New since Junior asked")).toBeVisible();
  await expect(checkout.getByText("Checkout p95 jumped after")).toBeVisible();
});

test("a pull request bundle shows the saved pull request card", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page, { open: [prMerge] });
  await page.goto(`${dashboard.baseURL}/review?item=${prMerge.id}`);
  const bundle = page.getByRole("region", {
    name: "Investigate checkout latency: review items",
  });
  await expect(
    bundle.getByRole("link", {
      name: "Retry checkout writes after lock timeouts",
    }),
  ).toBeVisible();
  await expect(bundle.getByText("fix/checkout-lock-retry")).toBeVisible();
  await screenshot(page, "review-desk-pull-request", {
    lightTheme: true,
    view: "desktop",
  });
});

test("each review item gets its own answer form", async ({
  dashboard,
  page,
}) => {
  const actions = await mockReviewItems(page);
  await page.goto(`${dashboard.baseURL}/review?item=${license.id}`);
  // This Conversation has no title, so the bundle is named after its newest
  // item, which changes as items close.
  const bundle = page.getByRole("region", { name: /: review items$/ });
  const licenseItem = bundle.getByRole("region", { name: license.title });
  const auditItem = bundle.getByRole("region", { name: audit.title });

  // A choice on one item must not carry over to the next item.
  await licenseItem.getByRole("radio", { name: "Approve" }).click();
  await expect(
    licenseItem.getByRole("radio", { name: "Approve" }),
  ).toBeChecked();
  await expect(
    auditItem.getByRole("radio", { name: "Approve" }),
  ).not.toBeChecked();

  await auditItem.getByRole("radio", { name: "Reject" }).click();
  await expect(auditItem.getByText("1 of 2 answered")).toBeVisible();
  // The note goes with the picked answer. It must not replace it.
  await auditItem.getByLabel("Anything else?").fill("Ask legal first.");
  await auditItem.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => actions.length).toBe(1);
  expect(actions[0]).toMatchObject({
    body: {
      action: "submit",
      answer: { other: "Ask legal first.", values: { decision: ["Reject"] } },
    },
    id: audit.id,
  });
  // The bundle stays open while it has items.
  await expect(licenseItem).toBeVisible();
});

test("after the last answer the next bundle opens", async ({
  dashboard,
  page,
}) => {
  const actions = await mockReviewItems(page, { open: [audit, rollout] });
  await page.goto(`${dashboard.baseURL}/review?item=${rollout.id}`);
  const checkout = page.getByRole("region", {
    name: "Investigate checkout latency: review items",
  });
  // Other… lets the reader answer a button question in their own words.
  await checkout.getByRole("button", { name: "Other…" }).click();
  await expect(checkout.getByLabel("Anything else?")).toBeFocused();
  await page.keyboard.type("Wait for the EU canary first.");
  // Every text box sends its form on Ctrl+Enter or Cmd+Enter.
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect.poll(() => actions.length).toBe(1);
  expect(actions[0]).toMatchObject({
    body: {
      action: "submit",
      answer: { other: "Wait for the EU canary first.", values: {} },
    },
    id: rollout.id,
  });
  await expect(checkout).toBeHidden();
  const next = page.getByRole("button", { name: new RegExp(audit.title) });
  await expect(next).toHaveAttribute("aria-expanded", "true");
  await expect(next).toBeFocused();
});

test("bundle keys mark done, snooze, and open the conversation", async ({
  dashboard,
  page,
}) => {
  const actions = await mockReviewItems(page, {
    open: [license, audit, rollout],
  });
  await page.goto(`${dashboard.baseURL}/review`);
  const todo = page.getByRole("region", { name: "To do" });
  await expect(todo.getByRole("button", { expanded: false })).toHaveCount(2);

  // h opens the snooze choices, and a number picks one. The next bundle
  // then opens in its place.
  await page.keyboard.press("j");
  await page.keyboard.press("h");
  await expect(page.getByRole("group", { name: "Snooze until" })).toBeVisible();
  await page.keyboard.press("2");
  const snoozed = page.getByRole("region", { name: "Snoozed" });
  await expect(snoozed).toBeVisible();
  await expect(todo.getByRole("button", { name: /globex/ })).toHaveCount(0);
  await expect(
    page.getByRole("region", {
      name: "Investigate checkout latency: review items",
    }),
  ).toBeVisible();

  // e closes every item in the bundle.
  await page.keyboard.press("e");
  await expect
    .poll(() => actions.map((action) => action.id))
    .toEqual([rollout.id]);
  await snoozed.getByRole("button", { name: "Snoozed" }).click();
  await snoozed.getByRole("button", { name: "Wake" }).click();
  await expect(snoozed).toBeHidden();

  // o opens the Conversation of the active bundle.
  await page.keyboard.press("j");
  await page.keyboard.press("o");
  await expect(page).toHaveURL(/\/conversations\//);
});

test("review item changes show as rows, not as context for other items", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page);
  // Right after Junior asked for this item, the person took another item and
  // then answered it. A Watch Event then arrived with the relay of someone's
  // take of this item from another Conversation.
  const takeText = `Dashboard User took review item "${answered.title}".`;
  const answerText = `Dashboard User answered review item "${answered.title}".`;
  await page.route(
    `**/api/conversations/${encodeURIComponent(conversationId)}*`,
    async (route) => {
      const response = await route.fetch({
        headers: {
          ...route.request().headers(),
          [CONVERSATION_DETAIL_VERSION_HEADER]: "",
        },
      });
      const detail = await response.json();
      const askedAt = Date.parse(rollout.createdAt);
      const change = (
        seq: number,
        kind: "submitted" | "taken",
        text: string,
      ) => ({
        seq,
        createdAt: new Date(askedAt + seq - 99_990).toISOString(),
        data: {
          type: "message",
          messageId: `${kind}-initech`,
          reviewItemChanges: [{ kind, reviewItemId: answered.id }],
          role: "user",
          source: "web",
          text,
        },
      });
      const relayText = `Someone took review item "${rollout.title}".`;
      const eventBatch = {
        seq: 100_002,
        createdAt: new Date(askedAt + 12).toISOString(),
        data: {
          type: "message",
          messageId: "event-batch",
          eventType: "pull_request.checks.failed",
          events: [
            {
              eventType: "pull_request.checks.failed",
              trustedSummary: "CI failed on run 7.",
            },
          ],
          reviewItemChanges: [{ kind: "taken", reviewItemId: rollout.id }],
          role: "user",
          text: `CI failed on run 7.\n\n${relayText}`,
          trustedSummary: "CI failed on run 7.",
        },
      };
      // The changes and the Event batch are the only messages after the ask.
      const before = (detail.events as { createdAt: string }[]).filter(
        (event) => Date.parse(event.createdAt) <= askedAt,
      );
      await route.fulfill({
        response,
        json: {
          ...detail,
          events: [
            ...before,
            change(100_000, "taken", takeText),
            change(100_001, "submitted", answerText),
            eventBatch,
          ],
        },
      });
    },
  );

  await page.goto(`${dashboard.baseURL}/review?item=${rollout.id}`);
  const detail = page.getByRole("region", {
    name: "Investigate checkout latency: review items",
  });
  await expect(detail.getByText("Checkout p95 jumped after")).toBeVisible();
  await expect(
    detail.getByRole("region", { name: new RegExp(answered.title) }),
  ).toHaveCount(0);
  // The Event batch stays as context, without its change row.
  await expect(
    detail.getByRole("button", { name: /CI failed on run 7\./ }),
  ).toBeVisible();
  await expect(
    detail.getByRole("region", { name: `Took ${rollout.title}` }),
  ).toHaveCount(0);

  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
  );
  // Each message shows its own change. The take stays a take after the
  // answer closed the item.
  const take = page.getByRole("region", { name: `Took ${answered.title}` });
  const answer = page.getByRole("region", {
    name: `Answered ${answered.title}`,
  });
  await expect(answer.getByText("MIT license, no change.")).toBeVisible();
  await expect(take).toBeVisible();
  await expect(take.getByText("MIT license, no change.")).toHaveCount(0);
  await expect(take.getByText("Done")).toHaveCount(0);
  await expect(page.getByText(takeText)).toHaveCount(0);
  await expect(page.getByText(answerText)).toHaveCount(0);
  // The relay shows as its change row next to the Watch Event, not as a
  // second Event line.
  await expect(
    page.getByRole("button", { name: /CI failed on run 7\./ }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: `Took ${rollout.title}` }),
  ).toBeVisible();
  await expect(page.getByText("1 events")).toHaveCount(0);
});

test("on mobile the inbox is the same queue", async ({ dashboard, page }) => {
  await mockReviewItems(page);
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`${dashboard.baseURL}/review?item=${rollout.id}`);
  await expect(
    page.getByRole("region", {
      name: "Investigate checkout latency: review items",
    }),
  ).toBeVisible();
  await screenshot(page, "review-desk-bundle", { view: "mobile" });
});

test("a search bundles open and archived items together", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page);
  await page.goto(`${dashboard.baseURL}/review`);
  await page.getByLabel("Search review items").fill("license");
  await expect(page).toHaveURL(/[?&]q=license/);
  const results = page.getByRole("list", { name: "Search results" });
  const bundle = results.getByRole("button", { expanded: false });
  await expect(bundle).toHaveCount(1);
  await expect(page.getByRole("region", { name: "To do" })).toHaveCount(0);
  await bundle.click();
  // A closed item shows its answer.
  await expect(results.getByText("MIT license, no change.")).toBeVisible();
  await screenshot(page, "review-desk-search", { view: "desktop" });
});

test("an empty inbox hides archived items", async ({ dashboard, page }) => {
  await mockReviewItems(page, { open: [] });
  await page.goto(`${dashboard.baseURL}/review`);
  await expect(page.getByText("All caught up")).toBeVisible();
  await expect(page.getByText(answered.title)).toHaveCount(0);
  await screenshot(page, "review-desk-empty", {
    lightTheme: true,
    view: "desktop",
  });
});

test("Send sends docked picks and asks before a message drops others", async ({
  dashboard,
  page,
}) => {
  // A notice fills the first page, so the question docks from the second.
  // The details panel answers the same item after the docked answer.
  const actions = await mockReviewItems(page, {
    keepOpen: true,
    open: [{ ...prReady, conversationIds: [conversationId] }, migration],
    pageSize: 1,
  });
  // Each message records how many answers were sent before it.
  const messages: { answersBefore: number; message: string }[] = [];
  const path = `**/api/conversations/${encodeURIComponent(conversationId)}`;
  await page.route(`${path}/messages`, async (route) => {
    messages.push({
      answersBefore: actions.length,
      message: route.request().postDataJSON().message,
    });
    await route.fulfill({
      json: { conversationId, messageId: "reply", status: "accepted" },
    });
  });
  // Show the tool call that added the item, as a live Turn does.
  await page.route(`${path}*`, async (route) => {
    const response = await route.fetch({
      headers: {
        ...route.request().headers(),
        [CONVERSATION_DETAIL_VERSION_HEADER]: "",
      },
    });
    const detail = await response.json();
    const last = detail.events.at(-1);
    await route.fulfill({
      response,
      json: {
        ...detail,
        events: [
          ...detail.events,
          {
            createdAt: last.createdAt,
            data: {
              calls: [
                {
                  name: "addReviewItem",
                  output: { item: { id: migration.id } },
                  status: "completed",
                  toolCallId: "add-migration",
                },
              ],
              type: "tool_calls",
            },
            seq: last.seq + 1,
          },
        ],
        isParticipant: true,
      },
    });
  });

  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
  );
  const question = page.getByRole("region", {
    name: `Question: ${migration.title}`,
  });
  const composer = page.getByLabel("Continue this conversation");

  // Picks in the details panel do not go with a message.
  await page
    .getByRole("button", { name: "Conversation details", exact: true })
    .click();
  const details = page.getByRole("region", { name: "Needs you" });
  await details.getByRole("button", { name: migration.title }).click();
  await details.getByRole("radio", { name: "Reject" }).click();

  // The message box sends the docked picks. With an empty draft no message
  // goes, so nothing asks about the details-panel picks.
  await expect(
    question.getByRole("textbox", { name: /Anything else/ }),
  ).toHaveCount(0);
  await expect(question.getByRole("button", { name: "Send" })).toHaveCount(0);
  await question.getByRole("radio", { name: "Approve" }).click();
  await composer.press("Enter");
  await expect
    .poll(() => actions)
    .toEqual([
      {
        body: {
          action: "submit",
          answer: { values: { decision: ["Approve"] } },
        },
        id: migration.id,
      },
    ]);
  const confirm = page.getByRole("alertdialog", {
    name: "Send without your answers?",
  });
  await expect(confirm).toHaveCount(0);
  expect(messages).toEqual([]);

  // A message drops the details-panel picks, so it asks first.
  await composer.fill("Friday works.");
  await composer.press("Enter");
  await expect(confirm).toContainText(migration.title);
  // A mobile view would close the details panel and its picks.
  await screenshot(page, "conversation-unsent-answers", { view: "desktop" });
  // Go back keeps the draft and the picks.
  await confirm.getByRole("button", { name: "Go back" }).click();
  await expect(confirm).toBeHidden();
  await expect(composer).toHaveValue("Friday works.");
  await expect(details.getByRole("radio", { name: "Reject" })).toBeChecked();
  expect(messages).toEqual([]);

  // The reader can send the message anyway.
  await composer.press("ControlOrMeta+Enter");
  await confirm.getByRole("button", { name: "Send message" }).click();
  await expect
    .poll(() => messages)
    .toEqual([{ answersBefore: 1, message: "Friday works." }]);
  expect(actions).toHaveLength(1);
});

test("each bundle groups its rows the way its filter reads", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page, {
    open: [rollout, license, audit, prReady, migration, prMerge, prReview],
  });
  await page.goto(`${dashboard.baseURL}/review`);
  const bundles = page.getByRole("complementary", { name: "Inbox bundles" });
  await expect(bundles.getByRole("link")).toHaveText([
    /^All/,
    /^Pull requests/,
    /^Decisions/,
    /^Automations/,
    /^Investigate checkout latency/,
    // A Conversation with no title is named after its newest item.
    new RegExp(`^${audit.title}`),
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
  await details.getByRole("button", { name: "Resume" }).click();
  await expect
    .poll(() => lifecycle)
    .toEqual([{ action: "resume", revision: editor.value.revision }]);
  await details.getByRole("link", { name: "Open editor" }).click();
  await expect(page).toHaveURL(/\/automations\/scheduled-1\/edit$/);
});

test("a sweep clears only FYI items, with an Undo", async ({
  dashboard,
  page,
}) => {
  const actions = await mockReviewItems(page, {
    open: [license, prReady, digest],
  });
  await page.goto(`${dashboard.baseURL}/review`);
  // The notice in the question's bundle and the FYI digest go; the
  // question stays.
  const sweep = page.getByRole("button", {
    name: "Clear 2 in All",
  });
  await sweep.click();
  const digestRow = page.getByRole("button", { name: /Digest skipped/ });
  await expect(digestRow).toHaveCount(0);
  const cleared = page.getByText("Cleared 2 items");
  await expect(cleared).toBeVisible();
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
