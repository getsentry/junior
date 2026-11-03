import type { Page } from "@playwright/test";
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

async function mockReviewItems(page: Page, options: { open?: unknown[] } = {}) {
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
  await page.route("**/api/review-items**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api\/review-items/, "");
    if (path === "/count") return route.fulfill({ json: { needsViewer: 3 } });
    if (path === "" || path === "/") {
      const q = url.searchParams.get("q")?.toLowerCase() ?? "";
      // A search also finds archived items, after the open ones.
      const list = q ? [...open, ...archived] : open;
      return route.fulfill({
        json: { items: list.filter((i) => i.title.toLowerCase().includes(q)) },
      });
    }
    const action = path.match(/^\/([^/]+)\/actions$/);
    if (action) {
      actions.push({
        body: route.request().postDataJSON(),
        id: decodeURIComponent(action[1]!),
      });
      return route.fulfill({ json: { ok: true } });
    }
    const item = items.find((i) => i.id === decodeURIComponent(path.slice(1)));
    return item
      ? route.fulfill({ json: item })
      : route.fulfill({ json: { error: "Not found" }, status: 404 });
  });
  return actions;
}

/** Show no blocked Automations, so an empty inbox is empty. */
async function mockNoBlockedAutomations(page: Page) {
  await page.route(
    (url) =>
      url.pathname.endsWith("/api/automations") &&
      url.searchParams.get("state") === "blocked",
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: { ...body, automations: [], total: 0 },
      });
    },
  );
}

test("each review item gets a fresh answer form", async ({
  dashboard,
  page,
}) => {
  const actions = await mockReviewItems(page);
  await page.goto(`${dashboard.baseURL}/review?item=${license.id}`);
  const detail = page.getByRole("region", { name: "Selected review item" });
  const list = page.getByRole("navigation", { name: "Review items" });
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
});

test("the inbox shows an item in its conversation", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page);
  await page.goto(`${dashboard.baseURL}/review`);
  const detail = page.getByRole("region", { name: "Selected review item" });
  const list = page.getByRole("navigation", { name: "Review items" });
  // The item that waited longest opens first.
  await expect(
    detail.getByRole("heading", { name: license.title }),
  ).toBeVisible();
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
    name: "Review item details",
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
  await page.goto(`${dashboard.baseURL}/review?item=${answered.id}`);
  await expect(
    detail.getByRole("link", { name: `Next: ${migration.title}` }),
  ).toBeVisible();
});

test("review item changes show as rows, not as context for other items", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page);
  // Right after Junior asked for this item, the person took another item and
  // then answered it.
  const takeText = `Dashboard User took review item "${answered.title}".`;
  const answerText = `Dashboard User answered review item "${answered.title}".`;
  await page.route(
    `**/api/conversations/${encodeURIComponent(conversationId)}`,
    async (route) => {
      const response = await route.fetch({
        headers: { ...route.request().headers(), "if-none-match": "" },
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
          reviewItemChange: { kind, reviewItemId: answered.id },
          role: "user",
          source: "web",
          text,
        },
      });
      // The changes are the only messages after the ask.
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
          ],
        },
      });
    },
  );

  await page.goto(`${dashboard.baseURL}/review?item=${rollout.id}`);
  const detail = page.getByRole("region", { name: "Selected review item" });
  await expect(
    detail.getByText("Find the slow checkout requests"),
  ).toBeVisible();
  await expect(
    detail.getByRole("region", { name: new RegExp(answered.title) }),
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
});

test("on mobile the list opens one item at a time", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page);
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`${dashboard.baseURL}/review`);
  const list = page.getByRole("navigation", { name: "Review items" });
  await expect(
    page.getByRole("region", { name: "Selected review item" }),
  ).toBeHidden();
  await screenshot(page, "review-desk-list", { view: "mobile" });

  await list.getByRole("link", { name: new RegExp(rollout.title) }).click();
  const detail = page.getByRole("region", { name: "Selected review item" });
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
  await mockReviewItems(page);
  await page.goto(`${dashboard.baseURL}/review`);
  const detail = page.getByRole("region", { name: "Selected review item" });
  await page.getByLabel("Search review items").fill("license");
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
  await mockReviewItems(page, { open: [] });
  await mockNoBlockedAutomations(page);
  await page.goto(`${dashboard.baseURL}/review`);
  const detail = page.getByRole("region", { name: "Selected review item" });
  await expect(detail.getByText("Nothing needs you")).toBeVisible();
  await expect(
    page.getByRole("link", { name: new RegExp(answered.title) }),
  ).toHaveCount(0);
  await screenshot(page, "review-desk-empty", { view: "desktop" });
});

test("a message asks before it drops unsent picks", async ({
  dashboard,
  page,
}) => {
  const actions = await mockReviewItems(page);
  const messages: string[] = [];
  const path = `**/api/conversations/${encodeURIComponent(conversationId)}`;
  await page.route(`${path}/messages`, async (route) => {
    messages.push(route.request().postDataJSON().message);
    await route.fulfill({
      json: { conversationId, messageId: "reply", status: "accepted" },
    });
  });
  // Show the tool call that added the item, so its card is in the transcript.
  await page.route(path, async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
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
  const card = page.getByRole("region", {
    name: `Review item: ${migration.title}`,
  });
  await card.getByRole("radio", { name: "Approve" }).click();
  const composer = page.getByLabel("Continue this conversation");
  await composer.fill("Thursday works.");
  await composer.press("Enter");

  // Go back keeps the draft and the picks.
  const confirm = page.getByRole("alertdialog", {
    name: "Send without your answers?",
  });
  await expect(confirm).toContainText(migration.title);
  await screenshot(page, "conversation-unsent-answers");
  await confirm.getByRole("button", { name: "Go back" }).click();
  await expect(confirm).toBeHidden();
  await expect(composer).toHaveValue("Thursday works.");
  await expect(card.getByRole("radio", { name: "Approve" })).toBeChecked();
  expect(messages).toEqual([]);

  // The reader can send the message anyway.
  await composer.press("Enter");
  await confirm.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => messages).toEqual(["Thursday works."]);
  await expect(composer).toHaveValue("");
  expect(actions).toEqual([]);
});
