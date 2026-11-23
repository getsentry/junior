import { CONVERSATION_DETAIL_VERSION_HEADER } from "@sentry/junior/api/schema";
import { expectRequestBudget } from "./request-budget";
import type { Page } from "@playwright/test";
import { failedRunAlert } from "./inbox/inbox-fixture";
import { screenshot } from "./screenshot";
import { expect, test } from "./test";

const viewer = {
  displayName: "Dashboard User",
  email: "dev@example.com",
  userId: "u-dev",
};

const base = {
  owner: { id: "slack:CREVIEW:1770003600.000200", kind: "conversation" },
  rootConversationId: "slack:CREVIEW:1770003600.000200",
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
  owner: { id: conversationId, kind: "conversation" },
  rootConversationId: conversationId,
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
  owner: { id: conversationId, kind: "conversation" },
  rootConversationId: conversationId,
  body: "The billing migration is ready.",
  conversationIds: [conversationId],
  createdAt: "2026-08-07T10:20:00.000Z",
  id: "item-migration",
  title: "Pick the billing migration window",
};

async function mockInboxItems(
  page: Page,
  options: { open?: unknown[]; pageSize?: number } = {},
) {
  const actions: { body: unknown; id: string }[] = [];
  const open = (options.open ?? [
    rollout,
    license,
    audit,
    prReady,
    migration,
  ]) as (typeof license)[];
  const archived = [answered];
  const items = [...open, ...archived];
  await page.route("**/api/inbox-items**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api\/inbox-items/, "");
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
      const id = decodeURIComponent(action[1]);
      actions.push({ body: route.request().postDataJSON(), id });
      const acted = items.find((i) => i.id === id);
      return acted
        ? route.fulfill({ json: acted })
        : route.fulfill({ json: { error: "Not found" }, status: 404 });
    }
    const item = items.find((i) => i.id === decodeURIComponent(path.slice(1)));
    return item
      ? route.fulfill({ json: item })
      : route.fulfill({ json: { error: "Not found" }, status: 404 });
  });
  return actions;
}

test("an old /review link opens the item in the Inbox", async ({
  dashboard,
  page,
}) => {
  await mockInboxItems(page);
  await page.goto(`${dashboard.baseURL}/review?item=${license.id}`);
  await expect(page).toHaveURL(`${dashboard.baseURL}/inbox?item=${license.id}`);
  await expect(
    page
      .getByRole("region", { name: "Selected inbox item" })
      .getByRole("heading", { name: license.title }),
  ).toBeVisible();
});

test("each inbox item gets a fresh answer form", async ({
  dashboard,
  page,
}) => {
  const actions = await mockInboxItems(page);
  await page.goto(`${dashboard.baseURL}/inbox?item=${license.id}`);
  const detail = page.getByRole("region", { name: "Selected inbox item" });
  const list = page.getByRole("navigation", { name: "Inbox items" });
  await expect(
    detail.getByRole("heading", { name: license.title }),
  ).toBeVisible();

  // A choice on one item must not carry over to the next item.
  await detail.getByRole("radio", { name: "Approve" }).click();
  await expect(detail.getByRole("radio", { name: "Approve" })).toBeChecked();
  await list.getByRole("link", { name: new RegExp(audit.title) }).click();
  await expect(
    detail.getByRole("heading", { name: audit.title }),
  ).toBeVisible();
  await expect(
    detail.getByRole("radio", { name: "Approve" }),
  ).not.toBeChecked();

  // A sent answer must not lock the form of the next item.
  await list.getByRole("link", { name: new RegExp(rollout.title) }).click();
  await detail.getByRole("button", { name: "Roll out" }).click();
  await detail.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => actions.length).toBe(1);
  expect(actions[0]).toMatchObject({
    body: { action: "submit", answer: { values: { go: ["Roll out"] } } },
    id: rollout.id,
  });
  await list.getByRole("link", { name: new RegExp(license.title) }).click();
  await expect(
    detail.getByRole("heading", { name: license.title }),
  ).toBeVisible();
  await detail.getByRole("radio", { name: "Reject" }).click();
  await expect(detail.getByText("1 of 2 answered")).toBeVisible();
  // The note goes with the picked answer. It must not replace it.
  await detail.getByLabel("Anything else?").fill("Ask legal first.");
  await detail.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => actions.length).toBe(2);
  expect(actions[1]).toMatchObject({
    body: {
      action: "submit",
      answer: { other: "Ask legal first.", values: { decision: ["Reject"] } },
    },
    id: license.id,
  });

  // The note line answers a button question in the reader's own words.
  await list.getByRole("link", { name: new RegExp(rollout.title) }).click();
  const note = detail.getByLabel("Anything else?");
  await note.fill("Wait for the EU canary first.");
  await screenshot(page, "review-desk-other", { view: "desktop" });
  const sent = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/inbox-items/${rollout.id}/actions`),
  );
  await note.press("Enter");
  await sent;
  expect(actions).toHaveLength(3);
  expect(actions[2]).toMatchObject({
    body: {
      action: "submit",
      answer: { other: "Wait for the EU canary first.", values: {} },
    },
    id: rollout.id,
  });
});

test("an item keeps unsent answers after another item or a reload", async ({
  dashboard,
  page,
}) => {
  await mockInboxItems(page);
  await page.goto(`${dashboard.baseURL}/inbox?item=${license.id}`);
  const detail = page.getByRole("region", { name: "Selected inbox item" });
  const list = page.getByRole("navigation", { name: "Inbox items" });
  await detail.getByRole("radio", { name: "Approve" }).click();
  await detail.getByLabel("Reason").fill("MIT license, no");

  await list.getByRole("link", { name: new RegExp(audit.title) }).click();
  await expect(
    detail.getByRole("heading", { name: audit.title }),
  ).toBeVisible();
  await list.getByRole("link", { name: new RegExp(license.title) }).click();
  await expect(detail.getByRole("radio", { name: "Approve" })).toBeChecked();
  await expect(detail.getByLabel("Reason")).toHaveValue("MIT license, no");

  await page.reload();
  await expect(detail.getByRole("radio", { name: "Approve" })).toBeChecked();
  await expect(detail.getByLabel("Reason")).toHaveValue("MIT license, no");
});

test("the inbox shows an item in its conversation", async ({
  dashboard,
  page,
}) => {
  await mockInboxItems(page);
  const detail = page.getByRole("region", { name: "Selected inbox item" });
  const list = page.getByRole("navigation", { name: "Inbox items" });
  await expectRequestBudget(
    page,
    async () => {
      await page.goto(`${dashboard.baseURL}/inbox`);
      // The item that waited longest opens first.
      await expect(
        detail.getByRole("heading", { name: license.title }),
      ).toBeVisible();
    },
    { requests: 9, serialRounds: 2 },
  );
  await expect(
    list.getByRole("link", { name: new RegExp(license.title) }),
  ).toHaveAttribute("aria-current", "page");
  // Archived items show only in a search.
  await expect(page.getByRole("region", { name: "Archived" })).toHaveCount(0);
  await expect(
    list.getByRole("link", { name: new RegExp(answered.title) }),
  ).toHaveCount(0);

  await list.getByRole("link", { name: new RegExp(rollout.title) }).click();
  await expect(detail.getByText("New since Junior asked")).toBeVisible();
  await expect(
    detail.getByText("Find the slow checkout requests"),
  ).toBeVisible();
  await expect(detail.getByRole("button", { name: "Roll out" })).toBeVisible();
  const details = page.getByRole("complementary", {
    name: "Inbox item details",
  });
  await expect(details.getByText(rollout.body)).toBeVisible();
  await screenshot(page, "review-desk", { lightTheme: true, view: "desktop" });

  await detail.getByRole("link", { name: `Next: ${prReady.title}` }).click();
  await expect(
    detail.getByRole("heading", { name: prReady.title }),
  ).toBeVisible();
  await expect(
    details.getByRole("link", { name: prReady.subject.title }),
  ).toBeVisible();

  // A closed item links to the open item after it, not to the oldest one.
  await page.goto(`${dashboard.baseURL}/inbox?item=${answered.id}`);
  await expect(
    detail.getByRole("link", { name: `Next: ${migration.title}` }),
  ).toBeVisible();
});

test("inbox item changes show as rows, not as context for other items", async ({
  dashboard,
  page,
}) => {
  await mockInboxItems(page);
  // Right after Junior asked for this item, the person took another item and
  // then answered it. A Watch Event then arrived with the relay of someone's
  // take of this item from another Conversation.
  const takeText = `Dashboard User took inbox item "${answered.title}".`;
  const answerText = `Dashboard User answered inbox item "${answered.title}".`;
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
      const relayText = `Someone took inbox item "${rollout.title}".`;
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

  await page.goto(`${dashboard.baseURL}/inbox?item=${rollout.id}`);
  const detail = page.getByRole("region", { name: "Selected inbox item" });
  await expect(
    detail.getByText("Find the slow checkout requests"),
  ).toBeVisible();
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

test("on mobile the list opens one item at a time", async ({
  dashboard,
  page,
}) => {
  await mockInboxItems(page);
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`${dashboard.baseURL}/inbox`);
  const list = page.getByRole("navigation", { name: "Inbox items" });
  await expect(
    page.getByRole("region", { name: "Selected inbox item" }),
  ).toBeHidden();
  await screenshot(page, "review-desk-list", { view: "mobile" });

  await list.getByRole("link", { name: new RegExp(rollout.title) }).click();
  const detail = page.getByRole("region", { name: "Selected inbox item" });
  await expect(
    detail.getByRole("heading", { name: rollout.title }),
  ).toBeVisible();
  await expect(list).toBeHidden();
  await screenshot(page, "review-desk-item", { view: "mobile" });
  await detail.getByRole("link", { name: "Inbox" }).click();
  await expect(list).toBeVisible();
});

test("a search lists open and archived items together", async ({
  dashboard,
  page,
}) => {
  await mockInboxItems(page);
  await page.goto(`${dashboard.baseURL}/inbox`);
  const detail = page.getByRole("region", { name: "Selected inbox item" });
  await page.getByLabel("Search inbox items").fill("license");
  await expect(page).toHaveURL(/[?&]q=license/);
  const results = page.getByRole("list", { name: "Search results" });
  await expect(results.getByRole("link")).toHaveCount(3);
  await expect(page.getByRole("region", { name: "Needs you" })).toHaveCount(0);
  await expect(
    results.getByRole("link", { name: new RegExp(answered.title) }),
  ).toContainText("Done");
  await screenshot(page, "review-desk-search", { view: "desktop" });
  await results.getByRole("link", { name: new RegExp(answered.title) }).click();
  await expect(
    detail.getByRole("heading", { name: answered.title }),
  ).toBeVisible();
  await expect(detail.getByText(/closed this/)).toBeVisible();
});

test("an empty inbox hides archived items", async ({ dashboard, page }) => {
  // The mock reporting has blocked Automations. Their alerts are Review
  // items, so they do not list again on their own.
  await mockInboxItems(page, { open: [] });
  await page.goto(`${dashboard.baseURL}/inbox`);
  const detail = page.getByRole("region", { name: "Selected inbox item" });
  await expect(detail.getByText("Nothing needs you")).toBeVisible();
  await expect(
    page.getByRole("link", { name: new RegExp(answered.title) }),
  ).toHaveCount(0);
  await screenshot(page, "review-desk-empty", { view: "desktop" });
});

test("a failed-run alert sends Pause to the server", async ({
  dashboard,
  page,
}) => {
  const alert = {
    ...base,
    body: "Last run failed.",
    id: "item-run-alert",
    owner: { id: "scheduled-1", kind: "automation" },
    request: failedRunAlert("scheduled-1", "Weekly project summary").request,
    rootConversationId: undefined,
    title: "Weekly project summary",
  };
  const actions = await mockInboxItems(page, { open: [alert] });
  await page.goto(`${dashboard.baseURL}/inbox`);
  await page.getByRole("link", { name: /Weekly project summary/ }).click();
  const detail = page.getByRole("region", { name: "Selected inbox item" });
  await expect(detail.getByRole("button", { name: "Run again" })).toBeVisible();
  // Core takes the step and reads no words, so there is no Other….
  await expect(detail.getByRole("button", { name: "Other…" })).toHaveCount(0);
  const sent = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/inbox-items/${alert.id}/actions`),
  );
  await detail.getByRole("button", { name: "Pause" }).click();
  await sent;
  expect(actions).toEqual([
    {
      body: { action: "submit", answer: { values: { step: ["Pause"] } } },
      id: alert.id,
    },
  ]);
});

test("an Automation alert names its Automation as its source", async ({
  dashboard,
  page,
}) => {
  const alert = {
    ...base,
    body: "Blocked: GitHub access expired. Fix the problem, then resume it.",
    id: "item-alert",
    owner: { id: "scheduled-1", kind: "automation" },
    rootConversationId: undefined,
    title: "Weekly project summary",
  };
  await mockInboxItems(page, { open: [alert] });
  await page.goto(`${dashboard.baseURL}/inbox`);
  const row = page.getByRole("link", { name: /Weekly project summary/ });
  await expect(row).toContainText("Automation");
  // It has no Conversation to excerpt, so it links to its Automation.
  await row.click();
  const detail = page.getByRole("region", { name: "Selected inbox item" });
  await expect(
    detail.getByRole("link", { name: /Open automation/ }),
  ).toBeVisible();
});

test("a message asks before it drops picks on a question card, and Send sends them", async ({
  dashboard,
  page,
}) => {
  // A notice fills the first page, so the question loads from the second.
  const actions = await mockInboxItems(page, {
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
                  name: "addInboxItem",
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
  // The question came from the second page, and its card in the
  // transcript holds the form.
  const card = page.getByRole("region", { name: `Asked ${migration.title}` });
  const approve = card.getByRole("radio", { name: "Approve" });
  await approve.click();
  await expect(card.getByText("1 of 2 answered")).toBeVisible();
  const composer = page.getByLabel("Continue this conversation");

  // A message drops the picks, so it asks first.
  await composer.fill("Friday works.");
  await composer.press("Enter");
  const confirm = page.getByRole("alertdialog", {
    name: "Send without your answers?",
  });
  await expect(confirm).toContainText(migration.title);
  await screenshot(page, "conversation-unsent-answers", { view: "desktop" });
  // Go back keeps the draft and the picks.
  await confirm.getByRole("button", { name: "Go back" }).click();
  await expect(confirm).toBeHidden();
  await expect(composer).toHaveText("Friday works.", { useInnerText: true });
  await expect(approve).toBeChecked();
  expect(messages).toEqual([]);
  expect(actions).toEqual([]);

  // The card's Send sends the picks, and then the message asks nothing.
  await card.getByRole("button", { name: "Send", exact: true }).click();
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
  await composer.press("Enter");
  await expect
    .poll(() => messages)
    .toEqual([{ answersBefore: 1, message: "Friday works." }]);
  await expect(confirm).toHaveCount(0);
});
