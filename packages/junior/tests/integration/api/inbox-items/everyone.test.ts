import type { User } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { getConversationStore, getDb } from "@/chat/db";
import { createAddInboxItemTool } from "@/chat/inbox-items/tools/add";
import { createSlackInboxItemToolServices } from "@/chat/slack/inbox-item-tools";
import { createSpace, joinSpace } from "@/chat/spaces/store";
import {
  juniorConversationParticipants,
  juniorConversations,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { getInboxItem, insertInboxItem } from "@/chat/inbox-items/store";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { buildSlackInboxItemCard } from "@/chat/slack/inbox-item-card";
import {
  closeConversationFixture,
  createConversationFixture,
  type ConversationFixture,
} from "../../../fixtures/conversation";

const CONVERSATION_ID = "slack:CPUB:1.000001";

/** A person signed in to the dashboard, linked to a Slack workspace. */
async function user(email: string, tenantId = "T123"): Promise<User> {
  const resolved = await resolveViewerUserFromSql(getDb(), email);
  if (!resolved) throw new Error(`no user for ${email}`);
  return {
    ...resolved,
    identities: [
      {
        id: `identity:slack:${email}`,
        provider: "slack",
        providerSubjectId: `U-${email}`,
        providerTenantId: tenantId,
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

    // Everyone stays in the owner's workspace: a person of another
    // workspace does not get these items in their Inbox.
    const carl = await user("carl@example.com", "T999");
    expect(
      (await api(fixture, carl)("?for=viewer&sort=waiting")).items,
    ).toEqual([]);

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

describe("inbox item in a private Conversation", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("cannot go to Everyone yet, and is only for the people who can see the Conversation", async () => {
    const fixture = await createConversationFixture();
    const privateId = "slack:CPRIV:1.000001";
    await getConversationStore().recordActivity({
      conversationId: privateId,
      destination: { platform: "slack", teamId: "T123", channelId: "CPRIV" },
      nowMs: Date.parse("2026-10-01T12:00:00.000Z"),
      source: "slack",
      visibility: "private",
    });
    const ana = await user("ana@example.com");
    const ben = await user("ben@example.com");
    // Ana takes part in the private Conversation. Ben does not.
    await getDb()
      .insert(juniorConversationParticipants)
      .values({
        lastMessageAt: new Date("2026-10-01T12:00:00.000Z"),
        rootConversationId: privateId,
        userId: ana.id,
      });
    const add = createAddInboxItemTool(
      {
        conversationId: privateId,
        resolveActorIdentity: async () => ({
          identity: { id: `identity:${ana.id}` } as any,
          user: ana,
        }),
        source: { kind: "slack" } as any,
      },
      createSlackInboxItemToolServices(() => fixture.queue),
    ) as any;
    const ask = (assignees?: string[]) =>
      add.execute(
        add.prepareArguments({
          kind: "action",
          title: "Pick a rollout day",
          body: "The deploy waits on a day.",
          ...(assignees ? { assignees } : undefined),
          request: {
            question: "Which day?",
            fields: [
              {
                id: "day",
                kind: "choice",
                label: "Day",
                options: [{ label: "Monday" }, { label: "Tuesday" }],
              },
            ],
          },
        }),
        {} as any,
      );
    // The old visibility check stays for the release before this one, so a
    // private item cannot name Everyone yet.
    await expect(ask(["everyone"])).rejects.toThrow(
      "cannot be assigned to Everyone",
    );
    const added = await ask();
    expect(added.item).toMatchObject({ visibility: "private" });

    // With no assignees named, the item goes to Ana, who asked.
    const anas = await api(fixture, ana)("?for=viewer&sort=waiting");
    expect(anas.items).toMatchObject([{ id: added.item.id, canAct: true }]);
    expect(await api(fixture, ana)(`/${added.item.id}`)).toMatchObject({
      id: added.item.id,
      canAct: true,
    });
    // Ben cannot see the Conversation, so the item is not for him.
    expect((await api(fixture, ben)("?for=viewer&sort=waiting")).items).toEqual(
      [],
    );
    expect((await api(fixture, ben)(`/${added.item.id}`)).id).toBeUndefined();
  });
});

describe("inbox item in a private Space", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("is up for grabs for the Space's members, not for a Participant who left it", async () => {
    const fixture = await createConversationFixture();
    const privateId = "slack:CSPACE:1.000001";
    const nowMs = Date.parse("2026-10-01T12:00:00.000Z");
    await getConversationStore().recordActivity({
      conversationId: privateId,
      destination: { platform: "slack", teamId: "T123", channelId: "CSPACE" },
      nowMs,
      source: "slack",
      visibility: "private",
    });
    const ana = await user("ana@example.com");
    const ben = await user("ben@example.com");
    const cy = await user("cy@example.com");
    // Ana and Ben take part in the Conversation. Its root is in Ana's
    // private Space, which Cy joined and Ben is not a member of.
    await getDb()
      .insert(juniorConversationParticipants)
      .values(
        [ana, ben].map((person) => ({
          lastMessageAt: new Date(nowMs),
          rootConversationId: privateId,
          userId: person.id,
        })),
      );
    const space = await createSpace({
      creatorUserId: ana.id,
      description: null,
      name: "Launch",
      visibility: "private",
    });
    await joinSpace(space.id, cy.id);
    await getDb()
      .update(juniorConversations)
      .set({ spaceId: space.id })
      .where(eq(juniorConversations.conversationId, privateId));
    const created = await insertInboxItem(getDb(), {
      owner: { id: privateId, kind: "conversation" },
      assignedToEveryone: false,
      assigneeUserIds: [],
      body: "It waits on a person.",
      conversationIds: [privateId],
      subject: { id: "space-ask", kind: "question" },
      kind: "notice",
      nowMs,
      title: "Launch notes",
    });
    if (!created) throw new Error("the item was not added");

    const list = async (viewer: User) =>
      (await api(fixture, viewer)("?for=viewer&sort=waiting")).items.map(
        (item: { id: string }) => item.id,
      );
    expect(await list(ana)).toEqual([created.id]);
    expect(await list(cy)).toEqual([created.id]);
    expect(await list(ben)).toEqual([]);
  });
});
