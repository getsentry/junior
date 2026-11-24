import type { User } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { conversationFeedSchema, inboxItemListSchema } from "@/api/schema";
import { getConversationStore, getDb } from "@/chat/db";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { closeInboxItem, insertInboxItem } from "@/chat/inbox-items/store";
import type { UserInputRequest } from "@/chat/inbox-items/user-input-request";
import { juniorConversationParticipants } from "@/db/schema";
import {
  closeConversationFixture,
  createConversationFixture,
  type ConversationFixture,
} from "../../../fixtures/conversation";
import { expectSqlBudget } from "../../../fixtures/sql-budget";

const ROLLOUT_ID = "slack:CPUB:1.000001";
const BUSY_ID = "slack:CPUB:1.000002";
const START_MS = Date.parse("2026-10-01T12:00:00.000Z");

const REQUEST: UserInputRequest = {
  question: "Roll out payments-v42 to every region?",
  fields: [
    {
      id: "go",
      kind: "choice",
      label: "Rollout",
      options: [{ label: "Roll out" }, { label: "Hold" }],
    },
    { id: "reason", kind: "text", label: "Reason" },
  ],
};

/** A person signed in to the dashboard, linked to Slack workspace T123. */
async function user(email: string): Promise<User> {
  const resolved = await resolveViewerUserFromSql(getDb(), email);
  if (!resolved) throw new Error(`no user for ${email}`);
  return {
    ...resolved,
    identities: [
      {
        id: `identity:slack:${email}`,
        provider: "slack",
        providerSubjectId: `U-${email}`,
        providerTenantId: "T123",
      },
    ],
  };
}

/** A public Slack Conversation that the person takes part in. */
async function conversationOf(
  conversationId: string,
  member: User,
): Promise<void> {
  await getConversationStore().recordActivity({
    conversationId,
    destination: { platform: "slack", teamId: "T123", channelId: "CPUB" },
    nowMs: START_MS,
    source: "slack",
    visibility: "public",
  });
  await getDb()
    .insert(juniorConversationParticipants)
    .values({
      lastMessageAt: new Date(START_MS),
      rootConversationId: conversationId,
      userId: member.id,
    });
}

/** Add an item in a Conversation and close it at `closedMs`. */
async function closedItem(input: {
  closedBy: User;
  closedMs: number;
  conversationId: string;
  key: string;
  pick?: string;
}): Promise<void> {
  const item = await insertInboxItem(getDb(), {
    subject: { id: input.key, kind: "agent" },
    owner: { id: input.conversationId, kind: "conversation" },
    assignedToEveryone: false,
    assigneeUserIds: [input.closedBy.id],
    body: "The rollout waits on a go-ahead.",
    conversationIds: [input.conversationId],
    kind: "action",
    nowMs: START_MS,
    request: REQUEST,
    title: "Roll out payments-v42",
    visibility: "public",
  });
  if (!item) throw new Error(`no item for ${input.key}`);
  await closeInboxItem(getDb(), {
    ...(input.pick
      ? {
          answer: {
            requestId: item.id,
            values: { go: [input.pick], reason: ["EU is out."] },
          },
        }
      : undefined),
    closedByUserId: input.closedBy.id,
    id: item.id,
    nowMs: input.closedMs,
    status: input.pick ? "done" : "dismissed",
  });
}

function api(fixture: ConversationFixture, viewer: User) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi({ conversationWorkQueue: fixture.queue }));
  return (path: string) => app.request(`http://localhost/api${path}`);
}

describe("conversation list API viewer answers", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("carries the viewer's answer however many items they closed since", async () => {
    const fixture = await createConversationFixture();
    const ana = await user("ana@example.com");
    const ben = await user("ben@example.com");
    await conversationOf(ROLLOUT_ID, ana);
    await conversationOf(BUSY_ID, ana);
    const answeredMs = START_MS + 60_000;
    await closedItem({
      closedBy: ana,
      closedMs: answeredMs,
      conversationId: ROLLOUT_ID,
      key: "rollout:ana",
      pick: "Hold",
    });
    // Later closes in the same Conversation: someone else's answer and the
    // viewer's own dismiss. Neither is the viewer's answer.
    await closedItem({
      closedBy: ben,
      closedMs: answeredMs + 1_000,
      conversationId: ROLLOUT_ID,
      key: "rollout:ben",
      pick: "Roll out",
    });
    await closedItem({
      closedBy: ana,
      closedMs: answeredMs + 2_000,
      conversationId: ROLLOUT_ID,
      key: "rollout:dismissed",
    });
    // A full page of later dismisses elsewhere pushes the answer off the
    // first page of the viewer's closed items.
    for (let index = 0; index < 50; index += 1) {
      await closedItem({
        closedBy: ana,
        closedMs: answeredMs + 10_000 + index,
        conversationId: BUSY_ID,
        key: `busy:${index}`,
      });
    }
    const read = api(fixture, ana);
    const closedPage = inboxItemListSchema.parse(
      await (await read("/inbox-items?status=done,dismissed")).json(),
    );
    expect(closedPage.items).toHaveLength(50);
    expect(closedPage.items.some((item) => item.owner.id === ROLLOUT_ID)).toBe(
      false,
    );

    const response = await expectSqlBudget(() => read("/conversations"), {
      statements: 17,
      serialRounds: 3,
    });
    expect(response.status).toBe(200);
    const rows = new Map(
      conversationFeedSchema
        .parse(await response.json())
        .conversations.map((row) => [row.conversationId, row]),
    );
    expect(rows.get(ROLLOUT_ID)?.viewerAnswer).toEqual({
      choices: ["Hold"],
      closedAt: new Date(answeredMs).toISOString(),
    });
    // Dismisses are not answers.
    expect(rows.get(BUSY_ID)).toBeDefined();
    expect(rows.get(BUSY_ID)?.viewerAnswer).toBeUndefined();
  });
});
