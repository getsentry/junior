import { CONVERSATION_DETAIL_VERSION_HEADER } from "@sentry/junior/api/schema";
import {
  answered,
  conversationId,
  migration,
  mockReviewItems,
  prReady,
  rollout,
} from "./inbox-fixture";
import { screenshot } from "./screenshot";
import { expect, test } from "./test";

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
  const details = page.getByRole("region", { name: "To do" });
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
