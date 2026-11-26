import {
  answered,
  conversationId,
  migration,
  mockInboxItems,
  prReady,
  rollout,
} from "./inbox-fixture";
import { desktop, screenshot } from "../screenshot";
import { expect, test } from "../test";
import { mockConversationDetail } from "../mock-reports";

test.describe("new UI", () => {
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
        const detail = await mockConversationDetail(route);
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

    // A closed item's link opens Done, with its row expanded. The link is
    // the shared inbox item path, which the new UI maps.
    const link = answer.getByRole("link", { name: answered.title });
    await expect(link).toHaveAttribute("href", `/inbox?item=${answered.id}`);
    await link.click();
    await expect(page).toHaveURL(/\/inbox\?view=done$/);
    await expect(
      page.getByRole("region", { name: `${answered.title}: how it closed` }),
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
      const detail = await mockConversationDetail(route);
      const last = detail.events.at(-1)!;
      await route.fulfill({
        json: {
          ...detail,
          events: [
            ...detail.events,
            {
              createdAt: last.createdAt,
              data: {
                calls: [
                  {
                    name: "askUserQuestion",
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

    // The shot is desktop only, so start at that size. At the default size,
    // the Approve option sits at the top edge of the transcript, and the
    // click can scroll it into view. That scroll leaves the latest message,
    // and the shot then shows another place.
    await page.setViewportSize(desktop);
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
});
