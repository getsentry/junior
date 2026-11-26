import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectConversationMessages } from "@/chat/conversations/message-projection";
import { getConversationEventStore, getDb } from "@/chat/db";
import { getInboxItem } from "@/chat/inbox-items/store";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { mswServer } from "../../msw/server";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import { linkSlackUser } from "../../fixtures/slack-user";
import { usersInfoOk } from "../../fixtures/slack/factories/api";

import {
  CARD_TS,
  SHIP_QUESTION,
  THREAD,
  addItem,
  blocksOf,
  buttonValue,
  inboxItemCardHarness,
  setUpInboxItemCards,
  slackThread,
  tearDownInboxItemCards,
} from "../../fixtures/slack/inbox-item-cards";
import { ask } from "../../fixtures/questions";

describe("Slack webhook: who answers an Inbox item card", () => {
  beforeEach(setUpInboxItemCards);
  afterEach(tearDownInboxItemCards);

  it("lets only an assignee act on a private item card", async () => {
    const { click, state } = inboxItemCardHarness();
    await slackThread(THREAD, "private");
    const ana = await linkSlackUser("ana@example.com", "U123");
    await linkSlackUser("ben@example.com", "U456");

    const { item } = await addItem(ana, {
      assignees: ["ana@example.com"],
      questions: ask("Rotate the deploy key?"),
    });

    const posts = slackApiOutbox.messages();
    expect(posts.map((post) => post.params["channel"])).toEqual(["C123"]);
    expect(blocksOf(posts[0])[0]?.text).toContain(
      "**Decision**: Rotate the deploy key?",
    );

    // Only an assignee can act. Ben gets an ephemeral note.
    await click({
      actionId: "junior_review_item:dismiss",
      actionTs: "1712345.0003",
      itemId: item.id,
      userId: "U456",
    });
    expect(slackApiOutbox.calls("chat.postEphemeral")[0]?.params).toMatchObject(
      { text: "Inbox item not found.", user: "U456" },
    );

    await click({
      actionId: "junior_review_item:dismiss",
      actionTs: "1712345.0004",
      itemId: item.id,
      userId: "U123",
    });
    const updates = slackApiOutbox.calls("chat.update");
    expect(updates).toHaveLength(1);
    expect(JSON.stringify(blocksOf(updates[0]))).toContain(
      "ana@example.com dismissed this",
    );
    // A dismiss starts no Turn. The thread saves it as a handled Message.
    const work = await getConversationWorkState({
      conversationId: THREAD,
      state,
    });
    expect(work?.messages ?? []).toEqual([]);
    const saved = projectConversationMessages(
      await getConversationEventStore().loadMessageHistory(THREAD),
    );
    expect(saved.map((message) => message.meta?.reviewItemChanges)).toEqual([
      [{ kind: "dismissed", reviewItemId: item.id }],
    ]);
  });

  it("lets anyone in a public channel answer its question, but not dismiss it", async () => {
    const { click, interact, state } = inboxItemCardHarness({
      allowedDomains: ["example.com"],
    });
    const emails: Record<string, string> = {
      U123: "ana@example.com",
      U456: "ben@example.com",
      UGUEST: "guest@contractor.dev",
    };
    mswServer.use(
      http.post("https://slack.com/api/users.info", async ({ request }) => {
        const user = new URLSearchParams(await request.text()).get("user")!;
        return HttpResponse.json(
          usersInfoOk({ userId: user, email: emails[user] }),
        );
      }),
    );
    await slackThread(THREAD, "public");
    const ana = await linkSlackUser("ana@example.com", "U123");
    await linkSlackUser("ben@example.com", "U456");
    await linkSlackUser("guest@contractor.dev", "UGUEST");
    await linkSlackUser("ext@partner.dev", "UEXT");

    // The agent asks without naming anyone, so the question goes to Ana.
    const { item } = await addItem(ana, {
      questions: [SHIP_QUESTION],
    });
    expect(item.assignees).toEqual(["ana@example.com"]);
    const shipIt = buttonValue(
      slackApiOutbox.messages()[0],
      "junior_review_item:choice:0",
    );
    const choose = (userId: string, actionTs: string, teamId = "T123") =>
      interact({
        type: "block_actions",
        team: { id: "T123" },
        trigger_id: "trigger-1",
        user: { id: userId, team_id: teamId },
        channel: { id: "C123" },
        message: { ts: CARD_TS, thread_ts: "1712345.0001" },
        actions: [
          {
            action_id: "junior_review_item:choice:0",
            action_ts: actionTs,
            type: "button",
            value: shipIt,
          },
        ],
      });

    // The workspace and domain checks still apply: a guest outside the
    // allowed domains and a Slack Connect user cannot answer.
    await choose("UGUEST", "1712345.0002");
    await choose("UEXT", "1712345.0003", "TEXTERNAL");
    expect((await getInboxItem(getDb(), item.id))?.status).toBe("open");

    // Ben is in the channel but not assigned. He can open the answer form
    // and answer, but only an assignee dismisses.
    await click({
      actionId: "junior_review_item:dismiss",
      actionTs: "1712345.0004",
      itemId: item.id,
      userId: "U456",
    });
    expect(slackApiOutbox.calls("chat.postEphemeral")[0]?.params).toMatchObject(
      { text: "Only an assignee can act on this item.", user: "U456" },
    );
    await click({
      actionId: "junior_review_item:answer",
      actionTs: "1712345.0005",
      itemId: item.id,
      userId: "U456",
    });
    expect(slackApiOutbox.calls("views.open")).toHaveLength(1);
    await choose("U456", "1712345.0006");

    const closed = await getInboxItem(getDb(), item.id);
    expect(closed).toMatchObject({
      closedBy: { email: "ben@example.com" },
      status: "done",
    });
    // The answer is Ben's own Slack input, so its Turn runs as him.
    const work = await getConversationWorkState({
      conversationId: THREAD,
      state,
    });
    expect(work?.messages.map((message) => message.input.authorId)).toEqual([
      "U456",
    ]);
    expect(work?.messages[0]?.input.text).toContain("Decision (q1): Ship it");
  });

  // Which open question a reply answers is a decision model choice, so the
  // classifier eval `inbox-item-replies.eval.ts` checks it with the real model.
  // These cases cover the rules that apply before or after that choice.
});
