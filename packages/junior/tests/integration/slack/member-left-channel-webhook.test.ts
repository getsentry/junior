import type { Identity, User } from "@sentry/junior-plugin-api";
import { createMemoryState } from "@chat-adapter/state-memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { createAddInboxItemTool } from "@/chat/inbox-items/tools/add";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import { createSlackInboxItemToolServices } from "@/chat/slack/inbox-item-tools";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { juniorConversationParticipants, juniorIdentities } from "@/db/schema";
import {
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
} from "../../fixtures/conversation-work";
import { createSlackWebhookTestClient } from "../../fixtures/slack/webhook-client";
import { resetTestEnv } from "../../fixtures/stub-env";

const SIGNING_SECRET = "test-signing-secret";
const queue = createConversationWorkQueueTestAdapter();

async function deliverMemberLeft(channelId: string, slackUserId: string) {
  const client = createSlackWebhookTestClient({
    signingSecret: SIGNING_SECRET,
  });
  return await handleSlackWebhook({
    request: client.event({
      team_id: "T123",
      type: "event_callback",
      event: {
        type: "member_left_channel",
        user: slackUserId,
        channel: channelId,
        channel_type: channelId.startsWith("G") ? "G" : "C",
        team: "T123",
        event_ts: "1712345.0001",
      },
    }),
    waitUntil: () => {},
    services: {
      getSlackAdapter: () =>
        createJuniorSlackAdapter({
          botToken: "xoxb-test-token",
          botUserId: "U0BOT",
          signingSecret: SIGNING_SECRET,
        }),
      queue,
      runtime: createNoopSlackWebhookRuntime(),
      state: createMemoryState(),
    },
  });
}

async function slackUser(email: string, slackUserId: string): Promise<User> {
  const user = await resolveViewerUserFromSql(getDb(), email);
  if (!user) throw new Error(`no user for ${email}`);
  await getDb()
    .insert(juniorIdentities)
    .values({
      createdAt: new Date(1),
      id: `identity:T123:${slackUserId}`,
      kind: "user",
      provider: "slack",
      providerSubjectId: slackUserId,
      providerTenantId: "T123",
      updatedAt: new Date(1),
      userId: user.id,
    });
  return user;
}

async function conversationWith(
  conversationId: string,
  channelId: string,
  visibility: "public" | "private",
  users: readonly User[],
): Promise<void> {
  await getConversationStore().recordActivity({
    conversationId,
    destination: { platform: "slack", teamId: "T123", channelId },
    nowMs: Date.parse("2026-10-01T12:00:00.000Z"),
    source: "slack",
    visibility,
  });
  await getDb()
    .insert(juniorConversationParticipants)
    .values(
      users.map((user) => ({
        lastMessageAt: new Date(1),
        rootConversationId: conversationId,
        userId: user.id,
      })),
    );
}

/** Each Participant as `root email`, sorted. */
async function participants(users: readonly User[]): Promise<string[]> {
  const rows = await getDb()
    .select({
      rootConversationId: juniorConversationParticipants.rootConversationId,
      userId: juniorConversationParticipants.userId,
    })
    .from(juniorConversationParticipants);
  return rows
    .map((row) => {
      const email = users.find((user) => user.id === row.userId)?.email;
      return `${row.rootConversationId} ${email}`;
    })
    .sort();
}

describe("Slack webhook: member_left_channel", () => {
  beforeEach(() => {
    resetTestEnv({ SLACK_BOT_TOKEN: "xoxb-test-token" });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await disconnectStateAdapter();
    await closeDb();
  });

  it("ends a person's access to the private channel they left", async () => {
    const ana = await slackUser("ana@example.com", "UANA");
    const ben = await slackUser("ben@example.com", "UBEN");
    const people = [ana, ben];
    await conversationWith("slack:GPRIV:1.000001", "GPRIV", "private", people);
    await conversationWith("slack:GOTHER:1.000002", "GOTHER", "private", [ben]);
    await conversationWith("slack:CPUB:1.000003", "CPUB", "public", [ben]);
    const add = createAddInboxItemTool(
      {
        conversationId: "slack:GPRIV:1.000001",
        resolveActorIdentity: async () => ({
          identity: { id: `identity:${ana.id}` } as Identity,
          user: ana,
        }),
        source: { kind: "slack" } as any,
      },
      createSlackInboxItemToolServices(() => queue),
    );
    const assignBen = () =>
      add.execute!(
        add.prepareArguments!({
          kind: "notice",
          title: "Rotate the key",
          body: "The deploy key expires on Friday.",
          assignees: ["ben@example.com"],
        }) as any,
        {} as any,
      );
    await expect(assignBen()).resolves.toBeDefined();

    expect((await deliverMemberLeft("GPRIV", "UBEN")).status).toBe(200);
    // Anyone can read a public Conversation, so leaving its channel keeps
    // Ben there.
    expect((await deliverMemberLeft("CPUB", "UBEN")).status).toBe(200);

    await expect(assignBen()).rejects.toThrow(
      "only to people in its Conversation",
    );
    expect(await participants(people)).toEqual([
      "slack:CPUB:1.000003 ben@example.com",
      "slack:GOTHER:1.000002 ben@example.com",
      "slack:GPRIV:1.000001 ana@example.com",
    ]);
  });
});
