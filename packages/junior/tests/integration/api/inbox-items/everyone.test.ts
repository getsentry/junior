import type { User } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { getConversationStore, getDb } from "@/chat/db";
import { getInboxItem, insertInboxItem } from "@/chat/inbox-items/store";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { buildSlackInboxItemCard } from "@/chat/slack/inbox-item-card";
import {
  closeConversationFixture,
  createConversationFixture,
  type ConversationFixture,
} from "../../../fixtures/conversation";

const CONVERSATION_ID = "slack:CPUB:1.000001";

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

function api(fixture: ConversationFixture, viewer: User) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi({ conversationWorkQueue: fixture.queue }));
  return async (path: string) =>
    await (await app.request(`http://localhost/api/inbox-items${path}`)).json();
}

async function addAsk(input: {
  assigneeUserIds: string[];
  key: string;
  nowMs: number;
}): Promise<string> {
  const created = await insertInboxItem(getDb(), {
    owner: { id: CONVERSATION_ID, kind: "conversation" },
    assignedToEveryone: false,
    assigneeUserIds: input.assigneeUserIds,
    body: "It waits on a person.",
    conversationIds: [CONVERSATION_ID],
    subject: { id: input.key, kind: "question" },
    kind: "action",
    nowMs: input.nowMs,
    request: {
      fields: [
        {
          id: "decision",
          kind: "choice",
          label: "Decision",
          options: [{ label: "Approve" }, { label: "Reject" }],
        },
      ],
      question: "Approve or reject this entry?",
    },
    title: `Ask ${input.key}`,
  });
  if (!created) throw new Error(`ask ${input.key} was not added`);
  return created.id;
}

describe("inbox item with no assignees", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("is up for grabs like an item for Everyone, so To do and its count match", async () => {
    const fixture = await createConversationFixture();
    const nowMs = Date.parse("2026-10-01T12:00:00.000Z");
    await getConversationStore().recordActivity({
      conversationId: CONVERSATION_ID,
      destination: { platform: "slack", teamId: "T123", channelId: "CPUB" },
      nowMs,
      source: "slack",
      visibility: "public",
    });
    const ana = await user("ana@example.com");
    const unassigned = await addAsk({ assigneeUserIds: [], key: "a", nowMs });
    const anasAsk = await addAsk({
      assigneeUserIds: [ana.id],
      key: "b",
      nowMs: nowMs + 1_000,
    });

    // The list that the dashboard reads. To do holds the asks that are not
    // for Everyone; Up for grabs holds the rest.
    const list = await api(fixture, ana)("?for=viewer&sort=waiting");
    expect(list.items).toMatchObject([
      { id: anasAsk, assignedToEveryone: false, canAct: true },
      { id: unassigned, assignedToEveryone: true, canAct: true, canTake: true },
    ]);
    const todo = list.items.filter(
      (item: { assignedToEveryone: boolean }) => !item.assignedToEveryone,
    );
    const count = await api(fixture, ana)("/count");
    expect(count).toMatchObject({ needsViewer: 1 });
    expect(todo).toHaveLength(count.needsViewer);
    expect(await api(fixture, ana)("/waiting-conversations")).toMatchObject({
      conversations: [{ items: [{ title: "Ask b" }] }],
    });

    // Its Slack card names Everyone, as the card of an item for Everyone does.
    const item = await getInboxItem(getDb(), unassigned);
    if (!item) throw new Error("the ask is missing");
    expect(buildSlackInboxItemCard(item, undefined).blocks[1]).toMatchObject({
      elements: expect.arrayContaining([
        { type: "mrkdwn", text: "For Everyone" },
      ]),
    });
  });
});
