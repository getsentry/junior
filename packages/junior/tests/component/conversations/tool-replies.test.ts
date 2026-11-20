import { afterEach, expect, it } from "vitest";
import { readConversationDetail } from "@/api/conversations/detail";
import { recordToolReply } from "@/chat/conversations/tool-replies";
import { getConversationEventStore } from "@/chat/db";
import {
  closeConversationFixture,
  createConversationFixture,
} from "../../fixtures/conversation";
import { signedInViewer } from "../../fixtures/user";

afterEach(closeConversationFixture);

it("shows a reply that a plugin tool posted once, and keeps it out of the tool result", async () => {
  const fixture = await createConversationFixture();
  const conversationId = "local:web:tool-replies";
  await fixture.conversationStore.recordActivity({
    conversationId,
    actor: { email: fixture.actor.email, fullName: fixture.actor.fullName },
    destination: { platform: "local", conversationId },
    source: "web",
    visibility: "private",
    title: "Tool replies",
    nowMs: Date.now(),
  });
  const url = "https://example.com/pull/1#comment-7";
  const text = "The empty state reuses the skeleton now.";
  const post = () =>
    recordToolReply({
      conversationId,
      plugin: "forge",
      result: { target: "comment", url, reply: { text, url } },
      toolCallId: "comment-1",
    });

  await expect(post()).resolves.toEqual({ target: "comment", url });
  // A retried tool call records no second reply.
  await post();

  const history = await getConversationEventStore().loadHistory(conversationId);
  const posted = history.filter((event) => event.data.type === "reply_posted");
  expect(posted).toHaveLength(1);
  const detail = await readConversationDetail(conversationId, {
    viewer: await signedInViewer(fixture.actor.email),
  });
  expect(
    detail?.events.find((event) => event.seq === posted[0]?.seq)?.data,
  ).toEqual({ type: "reply_posted", plugin: "forge", text, url });
});
