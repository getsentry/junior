import { CONVERSATION_DETAIL_VERSION_HEADER } from "@sentry/junior/api/schema";
import {
  answered,
  audit,
  conversationId,
  license,
  migration,
  mockReviewItems,
  prMerge,
  prReady,
  rollout,
} from "./review-desk-fixture";
import { screenshot } from "./screenshot";
import { expect, test } from "./test";

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
  // Closed items show only in Done. The pane's search is the only search.
  await expect(page.getByText(answered.title)).toHaveCount(0);
  await expect(page.getByRole("searchbox")).toHaveCount(0);
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
  // The answered item does not come back through its link.
  await expect(page).not.toHaveURL(/[?&]item=/);
  await expect(checkout).toBeHidden();
});

test("a link opens an open item that is not on the loaded page", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page, { open: [audit, rollout], pageSize: 1 });
  await page.goto(`${dashboard.baseURL}/review?item=${rollout.id}`);
  await expect(
    page.getByRole("region", {
      name: "Investigate checkout latency: review items",
    }),
  ).toBeVisible();
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

test("an Automations error does not read as an empty inbox", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page, { open: [] });
  await page.route(/\/api\/automations\?scope=attention/, (route) =>
    route.fulfill({ json: { error: "Failed" }, status: 500 }),
  );
  await page.goto(`${dashboard.baseURL}/review`);
  await expect(
    page.getByText("Could not load your Automations."),
  ).toBeVisible();
  await expect(page.getByText("All caught up")).toHaveCount(0);
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
