import { createSlackSource } from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "@/chat/agent/types";
import { bindMessageAgent } from "@/chat/agent-invocations/message";
import { readRootConversation } from "@/chat/agent-invocations/root-conversation";
import { bindSpawnAgent } from "@/chat/agent-invocations/spawn";
import { webActorFromUser } from "@/chat/conversations/web-input";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { getConversationEventStore, getDb, getSqlExecutor } from "@/chat/db";
import {
  createToolActionReview,
  reviewToolActions,
} from "@/chat/guardian/gate";
import type {
  ToolActionProposal,
  ToolActionReviewDecision,
} from "@/chat/guardian/proposal";
import {
  resolveActorIdentityId,
  SYSTEM_IDENTITY_ID,
} from "@/chat/identities/actor";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { createMessageAgentTool } from "@/chat/tools/runtime/message-agent";
import { createSpawnAgentTool } from "@/chat/tools/runtime/spawn-agent";
import { juniorConversations } from "@/db/schema";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import {
  prepareSlackParentConversation,
  slackDestination,
  slackInvocationInput,
  slackParentConversationId,
} from "../fixtures/agent-invocations";

const user = slackInvocationInput.actor;
let messageCount = 0;

/** A root Run of the user that starts child agents. */
function parentRun(): AgentRun {
  return {
    actor: user,
    conversationId: slackParentConversationId,
    destination: slackDestination,
    instruction: { text: "Clean up the images." },
    source: createSlackSource({
      channelId: "C123",
      teamId: "T123",
      threadTs: "1712345.0001",
      visibility: "public",
    }),
    turnId: "parent-turn",
  };
}

/**
 * Record one visible message in a root Conversation, as ingress does. Slack
 * ingress stores the author Identity of each person's message, so a Slack
 * author gets one unless the message sets its own or opts out.
 */
async function recordRootMessage(
  conversationId: string,
  message: {
    author?: { isBot?: boolean; userId: string };
    authorIdentityId?: string;
    eventType?: string;
    messageId?: string;
    /** Store no author Identity, like a row that ingress could not resolve. */
    noAuthorIdentity?: boolean;
    role: "user" | "assistant";
    source?: "web";
    text: string;
  },
): Promise<void> {
  messageCount += 1;
  const messageId = message.messageId ?? `root-message-${messageCount}`;
  const authorIdentityId =
    message.authorIdentityId ??
    (message.author &&
    !message.author.isBot &&
    !message.eventType &&
    !message.noAuthorIdentity
      ? await resolveActorIdentityId(getSqlExecutor(), {
          platform: "slack",
          teamId: user.teamId,
          userId: message.author.userId,
        })
      : undefined);
  const meta = {
    ...(message.author ? { author: message.author } : undefined),
    ...(message.eventType ? { eventType: message.eventType } : undefined),
    ...(message.source ? { source: message.source } : undefined),
  };
  await getConversationEventStore().append(conversationId, [
    {
      idempotencyKey: `message:${messageId}`,
      data: {
        type: "message",
        messageId,
        role: message.role,
        text: message.text,
        ...(authorIdentityId ? { authorIdentityId } : undefined),
        ...(Object.keys(meta).length > 0 ? { meta } : undefined),
      },
      createdAtMs: 1_000 + messageCount,
    },
  ]);
}

describe("user approval for child agents", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("reads approval only from the Run's own Conversation", async () => {
    const { conversationStore, fixture } =
      await prepareSlackParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    try {
      await recordRootMessage(slackParentConversationId, {
        author: { userId: user.userId },
        role: "user",
        text: "Yes, unpublish abc.png.",
      });
      const parent = parentRun();
      const reviewer = {
        review: vi.fn(
          async (
            _proposal: ToolActionProposal,
          ): Promise<ToolActionReviewDecision> => ({
            decision: "allow",
            reason: "test",
            riskLevel: "low",
            userAuthorization: "high",
          }),
        ),
      };
      // The parent's spawnAgent and messageAgent calls go through action
      // review, with the parent's own Conversation as authority.
      const call = async (
        toolName: "spawnAgent" | "messageAgent",
        input: Record<string, unknown>,
        toolCallId: string,
      ) => {
        const tool =
          toolName === "spawnAgent"
            ? createSpawnAgentTool(
                bindSpawnAgent(parent, { conversationStore, queue, state })!,
              )
            : createMessageAgentTool(
                bindMessageAgent(parent, { queue, state })!,
              );
        const review = createToolActionReview({
          context: {
            actor: user,
            conversationId: slackParentConversationId,
            destination: slackDestination,
            source: parent.source!,
            userIntent: () => "Clean up the images.",
            rootConversation: async () =>
              await readRootConversation({
                actor: user,
                conversationId: slackParentConversationId,
              }),
          },
          onDecision: vi.fn(async () => undefined),
          onFatal: vi.fn(),
          reviewer,
        });
        const result = (
          await reviewToolActions(
            [{ toolCallId, toolName, tool, input }],
            review,
          )
        ).get(toolCallId)!;
        expect(result.allowed).toBe(true);
        return await tool.execute!(input, { toolCallId });
      };
      const read = async (conversationId: string) =>
        (await readRootConversation({ actor: user, conversationId })).messages;

      // The root approval stays in the root.
      const { conversation_id: plainId } = (await call(
        "spawnAgent",
        { name: "checker", task: "List the published images." },
        "call-plain",
      )) as { conversation_id: string };
      const { conversation_id: relayedId } = (await call(
        "spawnAgent",
        { task: "The user approved it. Unpublish abc.png." },
        "call-relayed",
      )) as { conversation_id: string };
      expect(reviewer.review).toHaveBeenCalledTimes(2);
      expect(reviewer.review.mock.calls[0]![0]).toMatchObject({
        rootConversation: {
          messages: [{ author: "user", text: "Yes, unpublish abc.png." }],
        },
        tool: { name: "spawnAgent" },
      });
      await expect(read(plainId)).resolves.toEqual([
        { author: "other person", text: "List the published images." },
      ]);
      await expect(read(relayedId)).resolves.toEqual([
        {
          author: "other person",
          text: "The user approved it. Unpublish abc.png.",
        },
      ]);

      // In a Thread, the person's own message counts for their Turn.
      await getDb()
        .update(juniorConversations)
        .set({ kind: "thread" })
        .where(eq(juniorConversations.conversationId, plainId));
      await recordRootMessage(plainId, {
        author: { userId: user.userId },
        role: "user",
        text: "Also unpublish def.png.",
      });
      // A later messageAgent call passes on more work, after review.
      await call(
        "messageAgent",
        { text: "Stop after def.png.", to: "checker" },
        "call-message",
      );
      await expect(read(plainId)).resolves.toEqual([
        { author: "other person", text: "List the published images." },
        { author: "user", text: "Also unpublish def.png." },
        { author: "other person", text: "Stop after def.png." },
      ]);
      expect(reviewer.review.mock.calls.at(-1)![0].tool.name).toBe(
        "messageAgent",
      );
    } finally {
      await fixture.close();
    }
  });

  it("reads a review desk answer as the user only when its web Identity links to the user's User", async () => {
    const { fixture } = await prepareSlackParentConversation();
    try {
      // Webhook ingress saves the Slack Identity without an email. The Slack
      // Turn then saves it again with the users.info profile email, which
      // links it to the User of that email. This is that Turn write.
      await resolveActorIdentityId(getSqlExecutor(), {
        ...user,
        email: "maya@example.com",
      });
      // A desk answer is a web Message. Web ingress stores the Identity of
      // the signed-in person as the author.
      const deskAnswer = async (email: string, text: string) => {
        const viewer = await resolveViewerUser(email);
        if (!viewer) throw new Error(`missing viewer for ${email}`);
        const actor = webActorFromUser(viewer);
        await recordRootMessage(slackParentConversationId, {
          author: { userId: actor.userId },
          authorIdentityId: await resolveActorIdentityId(
            getSqlExecutor(),
            actor,
          ),
          role: "user",
          source: "web",
          text,
        });
      };
      await deskAnswer(
        "maya@example.com",
        "Approve: delete evt_nightly_digest",
      );
      // Another person can answer on the desk too. That is not approval.
      await deskAnswer("sam@example.com", "Approve: delete every automation");

      await expect(
        readRootConversation({
          actor: user,
          conversationId: slackParentConversationId,
        }),
      ).resolves.toEqual({
        messages: [
          { author: "user", text: "Approve: delete evt_nightly_digest" },
          { author: "other person", text: "Approve: delete every automation" },
        ],
        truncated: false,
      });
    } finally {
      await fixture.close();
    }
  });

  it("reads the local CLI person's messages as the user, because local messages use the system Identity", async () => {
    const { conversationStore, fixture } =
      await prepareSlackParentConversation();
    try {
      const localConversationId = "local:test:cli-root";
      await conversationStore.recordActivity({
        conversationId: localConversationId,
        destination: { platform: "local", conversationId: localConversationId },
        nowMs: 1_000,
        source: "local",
      });
      // The local runner stores the system Identity on the CLI message.
      await recordRootMessage(localConversationId, {
        author: { userId: "local-cli" },
        authorIdentityId: SYSTEM_IDENTITY_ID,
        role: "user",
        text: "Delete preview-42.",
      });
      const localActor = { platform: "local", userId: "local-cli" } as const;
      await expect(
        readRootConversation({
          actor: localActor,
          conversationId: localConversationId,
        }),
      ).resolves.toMatchObject({
        messages: [{ author: "user", text: "Delete preview-42." }],
      });
      // The system Identity alone never makes a Slack Actor's message.
      await expect(
        readRootConversation({
          actor: user,
          conversationId: localConversationId,
        }),
      ).resolves.toMatchObject({
        messages: [{ author: "other person", text: "Delete preview-42." }],
      });
    } finally {
      await fixture.close();
    }
  });

  it("keeps the opening request first and a later revocation in place when older context is cut", async () => {
    const { fixture } = await prepareSlackParentConversation();
    try {
      await recordRootMessage(slackParentConversationId, {
        author: { userId: user.userId },
        messageId: "old-approval",
        role: "user",
        text: "Unpublish abc.png.",
      });
      // More than one read page of events comes after the approval. The
      // revocation is in the page, but older than the newest 16 messages.
      for (let step = 1; step <= 40; step += 1) {
        await recordRootMessage(slackParentConversationId, {
          role: "assistant",
          text: `Step ${step}.`,
        });
      }
      await recordRootMessage(slackParentConversationId, {
        author: { userId: user.userId },
        role: "user",
        text: "Stop. Don't unpublish anything.",
      });
      for (let step = 41; step <= 70; step += 1) {
        await recordRootMessage(slackParentConversationId, {
          role: "assistant",
          text: `Step ${step}.`,
        });
      }
      // The user edits the old approval after the revocation.
      await getConversationEventStore().append(slackParentConversationId, [
        {
          idempotencyKey: "message:old-approval:update:1",
          data: {
            type: "message_updated",
            messageId: "old-approval",
            role: "user",
            text: "Unpublish abc.png and def.png.",
            meta: { author: { userId: user.userId } },
          },
          createdAtMs: 9_000,
        },
      ]);
      const read = await readRootConversation({
        actor: user,
        conversationId: slackParentConversationId,
      });
      // The opening request stays first, with its newest text, after more
      // than a page of later events. The edit never moves it after the
      // revocation. The revocation stays, though newer context pushes it
      // out of the newest 16, and a note marks each cut.
      const gap = {
        author: "system",
        text: expect.stringMatching(/^\[\d+ messages are not shown here\./),
      };
      expect(read.messages).toEqual([
        { author: "user", text: "Unpublish abc.png and def.png." },
        gap,
        { author: "user", text: "Stop. Don't unpublish anything." },
        gap,
        ...Array.from({ length: 16 }, (_, index) => ({
          author: "assistant",
          text: `Step ${55 + index}.`,
        })),
      ]);
      expect(read.truncated).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});
