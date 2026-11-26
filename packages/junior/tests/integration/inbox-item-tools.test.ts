import { createSearchInboxItemsTool } from "@/chat/inbox-items/tools/search";
import type { Identity, User } from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { actOnInboxItem } from "@/chat/inbox-items/actions";
import {
  closeInboxItem,
  getInboxItem,
  insertInboxItem,
} from "@/chat/inbox-items/store";
import {
  juniorAutomations,
  juniorConversationParticipants,
  juniorIdentities,
  juniorInboxItems,
} from "@/db/schema";
import { createUpdateInboxItemTool } from "@/chat/inbox-items/tools/update";
import { listOpenAutomationQuestions } from "@/chat/inbox-items/automation-questions";
import { createAddInboxItemTool } from "@/chat/inbox-items/tools/add";
import { recordAutomationExecution } from "@/chat/automations/execution-stats";
import { createSlackInboxItemToolServices } from "@/chat/slack/inbox-item-tools";
import { getConversation } from "@/chat/task-execution/store";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";

type Context = Pick<
  ToolRuntimeContext,
  "actorIsApp" | "conversationId" | "resolveActorIdentity" | "source" | "turnId"
>;

// Parse the input first, as the agent runtime does.
async function execute(tool: any, input: unknown): Promise<any> {
  return await tool.execute(tool.prepareArguments(input), {} as any);
}

const queue = createConversationWorkQueueTestAdapter();

const services = createSlackInboxItemToolServices(() => queue);

function tools(context: Context) {
  return {
    add: createAddInboxItemTool(context, services),
    search: createSearchInboxItemsTool(context, services),
    update: createUpdateInboxItemTool(context, services),
  };
}

async function user(email: string): Promise<User> {
  const resolved = await resolveViewerUserFromSql(getDb(), email);
  if (!resolved) throw new Error(`no user for ${email}`);
  return resolved;
}

function asActor(actor: User | undefined): Context["resolveActorIdentity"] {
  return async () =>
    actor
      ? { identity: { id: `identity:${actor.id}` } as Identity, user: actor }
      : undefined;
}

async function conversation(
  conversationId: string,
  channelId: string,
  visibility: "public" | "private",
  teamId = "T123",
): Promise<void> {
  await getConversationStore().recordActivity({
    conversationId,
    destination: { platform: "slack", teamId, channelId },
    nowMs: Date.parse("2026-10-01T12:00:00.000Z"),
    source: "slack",
    visibility,
  });
}

const REQUEST = {
  question: "Approve or reject this entry?",
  fields: [
    {
      id: "decision",
      kind: "choice",
      label: "Decision",
      options: [{ label: "Approve" }, { label: "Reject" }],
    },
    { id: "reason", kind: "text", label: "Reason" },
  ],
};

function automationRun(conversationId: string, turnId?: string): Context {
  return {
    conversationId,
    resolveActorIdentity: asActor(undefined),
    source: { kind: "scheduled_automation" },
    ...(turnId ? { turnId } : undefined),
  };
}

describe("inbox item tools", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("changes a question of an earlier run by its id", async () => {
    await conversation("slack:CPUB:1.000001", "CPUB", "public");
    await conversation("slack:CPUB:1.000002", "CPUB", "public");
    const ana = await user("ana@example.com");
    await user("ben@example.com");
    const first = tools(automationRun("slack:CPUB:1.000001", "turn-1"));
    const second = tools(automationRun("slack:CPUB:1.000002", "turn-2"));
    const add = {
      kind: "action",
      title: "Review acme entry",
      body: "The acme entry changed its license.",
      assignees: ["ana@example.com", "ben@example.com"],
      request: REQUEST,
    };

    await expect(
      execute(first.add, { ...add, request: undefined }),
    ).rejects.toThrow(
      "An action item needs a `request` with a `question` and `fields`.",
    );
    const recommendBoth = {
      ...REQUEST,
      fields: [
        {
          ...REQUEST.fields[0],
          options: [
            { label: "Approve", recommended: true },
            { label: "Reject", recommended: true },
          ],
        },
      ],
    };
    await expect(
      execute(first.add, { ...add, request: recommendBoth }),
    ).rejects.toThrow("can recommend only one option");
    const added = await execute(first.add, add);
    // Each add asks a new question, with its own id.
    expect(added.item.subject).toEqual({
      id: expect.stringMatching(/^ask:/),
      kind: "question",
    });
    const again = await execute(second.update, {
      id: added.item.id,
      title: "Review acme entry again",
      assignees: ["ana@example.com"],
    });
    expect(again.item).toMatchObject({
      id: added.item.id,
      title: "Review acme entry again",
      assignees: ["ana@example.com"],
      visibility: "public",
    });
    // A later run changes the choices of the question by its id.
    const changed = await execute(second.update, {
      id: added.item.id,
      request: {
        ...REQUEST,
        fields: [
          {
            ...REQUEST.fields[0],
            options: [{ label: "Approve" }, { label: "Hold" }],
          },
        ],
      },
    });
    expect(changed.item.request.fields[0].options).toEqual([
      { label: "Approve" },
      { label: "Hold" },
    ]);
    await expect(
      execute(second.update, {
        id: added.item.id,
        request: {
          related: [{ label: "Spec", url: "https://example.com/spec" }],
        },
      }),
    ).rejects.toThrow(
      "An action item needs a `request` with a `question` and `fields`.",
    );
    // The item points to the Turn that asked it, not the one that changed it.
    expect((await getInboxItem(getDb(), added.item.id))?.addedByTurnId).toBe(
      "turn-1",
    );

    // A person in another public Conversation finds it by its question id.
    await conversation("slack:COTHER:1.000003", "COTHER", "public");
    const reader = tools({
      conversationId: "slack:COTHER:1.000003",
      resolveActorIdentity: asActor(ana),
      source: { kind: "web", conversationId: "web:1" } as any,
    });
    const found = await execute(reader.search, {
      subject_id: added.item.subject.id,
    });
    expect(found.items.map((item: any) => item.id)).toEqual([added.item.id]);
    expect(
      (await execute(reader.search, { assignee: "ana@example.com" })).count,
    ).toBe(1);

    // A Slack mention resolves only inside the workspace of the item.
    const ben = await user("ben@example.com");
    await getDb()
      .insert(juniorIdentities)
      .values({
        createdAt: new Date(1),
        id: "identity:T999:U999",
        kind: "user",
        provider: "slack",
        providerSubjectId: "U999",
        providerTenantId: "T999",
        updatedAt: new Date(1),
        userId: ben.id,
      });
    await expect(
      execute(first.update, { id: added.item.id, assignees: ["<@U999>"] }),
    ).rejects.toThrow("<@U999> has no User yet");

    // A public item stays inside its Slack workspace.
    await conversation("slack:CFAR:1.000004", "CFAR", "public", "T999");
    // Ana is assigned, but an agent there still cannot read or change it.
    const outsider = tools({
      conversationId: "slack:CFAR:1.000004",
      resolveActorIdentity: asActor(ana),
      source: { kind: "slack" } as any,
    });
    expect((await execute(outsider.search, {})).count).toBe(0);
    const theirs = await execute(outsider.add, add);
    expect(theirs.item.id).not.toBe(added.item.id);
    await expect(
      execute(outsider.update, {
        id: added.item.id,
        status: "done",
        reason: "not mine",
      }),
    ).rejects.toThrow("is not found");
    await expect(
      execute(first.update, {
        id: added.item.id,
        conversation_ids: ["slack:CPUB:1.000001", "slack:CFAR:1.000004"],
      }),
    ).rejects.toThrow("Conversation slack:CFAR:1.000004 is not found.");
  });

  it("keeps an item of a private Conversation for its assigned Users", async () => {
    await conversation("slack:CPRIV:1.000001", "CPRIV", "private");
    await conversation("slack:CPUB:1.000002", "CPUB", "public");
    const ana = await user("ana@example.com");
    const ben = await user("ben@example.com");
    const owner = tools({
      conversationId: "slack:CPRIV:1.000001",
      resolveActorIdentity: asActor(ana),
      source: { kind: "slack" } as any,
    });
    const notice = {
      kind: "notice",
      title: "Rotate the key",
      body: "The deploy key expires on Friday.",
    };

    await expect(
      execute(owner.add, { ...notice, assignees: ["everyone"] }),
    ).rejects.toThrow("cannot be assigned to Everyone");
    // Ben never took part in the private Conversation.
    await expect(
      execute(owner.add, { ...notice, assignees: ["ben@example.com"] }),
    ).rejects.toThrow("only to people in its Conversation");
    await expect(
      execute(owner.add, {
        ...notice,
        assignees: ["ana@example.com"],
        conversation_ids: ["slack:CPUB:1.000002"],
      }),
    ).rejects.toThrow("links only to the Conversation that added it");
    const added = await execute(owner.add, {
      ...notice,
      assignees: ["ana@example.com"],
    });
    expect(added.item.visibility).toBe("private");
    // Its own Conversation cannot make it public by changing its links.
    await expect(
      execute(owner.update, {
        id: added.item.id,
        conversation_ids: ["slack:CPUB:1.000002"],
      }),
    ).rejects.toThrow("links only to the Conversation that added it");
    // Nor can it drop its own link and hide the item from itself.
    const relinked = await execute(owner.update, {
      id: added.item.id,
      conversation_ids: [],
    });
    expect(relinked.item.conversation_ids).toEqual(["slack:CPRIV:1.000001"]);
    // Ana is assigned, but an agent in a public Conversation cannot read it
    // into that Conversation.
    const anaInPublic = tools({
      conversationId: "slack:CPUB:1.000002",
      resolveActorIdentity: asActor(ana),
      source: { kind: "slack" } as any,
    });
    expect((await execute(anaInPublic.search, {})).count).toBe(0);
    await expect(
      execute(anaInPublic.update, { id: added.item.id, title: "Seen" }),
    ).rejects.toThrow("is not found");

    // Ben is not assigned and his Conversation is not linked.
    const other = tools({
      conversationId: "slack:CPUB:1.000002",
      resolveActorIdentity: asActor(ben),
      source: { kind: "slack" } as any,
    });
    expect((await execute(other.search, {})).count).toBe(0);
    await expect(
      execute(other.update, { id: added.item.id, title: "Mine now" }),
    ).rejects.toThrow("is not found");
    // A private Conversation cannot write into a public item, because other
    // Conversations read that item.
    const shared = await execute(other.add, {
      ...notice,
      assignees: ["everyone"],
    });
    await expect(
      execute(owner.update, { id: shared.item.id, body: "Private detail." }),
    ).rejects.toThrow("A public item changes only from a public Conversation");
    // Nor can he link a private Conversation that he cannot see.
    await expect(
      execute(other.add, {
        ...notice,
        assignees: ["ben@example.com"],
        conversation_ids: ["slack:CPRIV:1.000001"],
      }),
    ).rejects.toThrow("Conversation slack:CPRIV:1.000001 is not found.");
  });

  it("keeps the people of a private Automation item in later runs", async () => {
    await conversation("slack:DRUN:1.000001", "DRUN", "private");
    await conversation("slack:DRUN:1.000002", "DRUN", "private");
    const ana = await user("ana@example.com");
    await getDb()
      .insert(juniorConversationParticipants)
      .values({
        lastMessageAt: new Date(1),
        rootConversationId: "slack:DRUN:1.000001",
        userId: ana.id,
      });
    await getDb()
      .insert(juniorIdentities)
      .values({
        createdAt: new Date(1),
        id: "identity:creator",
        kind: "user",
        provider: "slack",
        providerSubjectId: "UCREATOR",
        providerTenantId: "T123",
        updatedAt: new Date(1),
        userId: ana.id,
      });
    await getDb()
      .insert(juniorAutomations)
      .values({
        channelId: "DRUN",
        createdAtMs: 1,
        creatorIdentityId: "identity:creator",
        creatorSlackUserId: "UCREATOR",
        id: "auto-digest",
        instruction: "Post the digest.",
        kind: "scheduled",
        record: {} as any,
        status: "active",
        teamId: "T123",
      });
    const run = (conversationId: string) =>
      tools({
        conversationId,
        resolveActorIdentity: asActor(undefined),
        source: {
          automationId: "auto-digest",
          kind: "scheduled_automation",
        } as any,
      });
    // Each run's row links its Conversation before the run acts, so later
    // runs know the items that it added.
    const started = (conversationId: string) =>
      recordAutomationExecution("auto-digest", {
        conversationId,
        executionId: `run-${conversationId}`,
      });
    const notice = {
      kind: "notice",
      title: "Digest needs a look",
      body: "Two entries changed.",
      assignees: ["ana@example.com"],
    };

    // A new run has no Actor and no people yet. It assigns the creator of
    // its Automation by default, and nobody else.
    await conversation("slack:DRUN:1.000003", "DRUN", "private");
    await user("ben@example.com");
    const fresh = await execute(run("slack:DRUN:1.000003").add, {
      ...notice,
      assignees: undefined,
    });
    expect(fresh.item.assignees).toEqual(["ana@example.com"]);
    await expect(
      execute(run("slack:DRUN:1.000003").add, {
        ...notice,
        assignees: ["ben@example.com"],
      }),
    ).rejects.toThrow("only to people in its Conversation");

    await started("slack:DRUN:1.000001");
    const added = await execute(run("slack:DRUN:1.000001").add, notice);
    // A later run gets the open questions of earlier runs in its task.
    expect(await listOpenAutomationQuestions(getDb(), "auto-digest")).toEqual([
      { id: added.item.id, title: "Digest needs a look" },
    ]);
    // Ana took part only in the first run, which added the item.
    const again = await execute(run("slack:DRUN:1.000002").update, {
      id: added.item.id,
      body: "Three entries changed.",
    });
    expect(again.item).toMatchObject({
      body: "Three entries changed.",
      assignees: ["ana@example.com"],
    });

    // A run in a private Conversation cannot write into the public item of
    // an earlier run.
    await conversation("slack:CPUB:1.000009", "CPUB", "public");
    await started("slack:CPUB:1.000009");
    const shared = await execute(run("slack:CPUB:1.000009").add, {
      ...notice,
      assignees: ["everyone"],
    });
    expect(shared.item.visibility).toBe("public");
    await expect(
      execute(run("slack:DRUN:1.000002").update, {
        id: shared.item.id,
        body: "Private detail.",
      }),
    ).rejects.toThrow("A public item changes only from a public Conversation");
  });

  it("assigns the active Participants when a Turn without a person asks", async () => {
    // A dashboard Conversation that Ana started and Ben joined. An event
    // Turn, such as a watched pull request that merged, has a system Actor.
    const ana = await user("ana@example.com");
    const ben = await user("ben@example.com");
    await getConversationStore().recordActivity({
      actor: { email: "ana@example.com" },
      conversationId: "local:web:shared",
      destination: { platform: "local", conversationId: "local:web:shared" },
      nowMs: Date.parse("2026-10-01T12:00:00.000Z"),
      source: "web",
      visibility: "private",
    });
    await getDb()
      .insert(juniorConversationParticipants)
      .values({
        lastMessageAt: new Date("2026-10-01T12:05:00.000Z"),
        rootConversationId: "local:web:shared",
        userId: ben.id,
      });
    const eventTurn = (conversationId: string) =>
      tools({
        conversationId,
        resolveActorIdentity: asActor(undefined),
        source: { kind: "event" } as any,
      });
    const ask = {
      kind: "action",
      title: "Close the tracking issue?",
      body: "The pull request merged.",
      request: REQUEST,
    };

    const added = await execute(eventTurn("local:web:shared").add, ask);
    expect(added.item).toMatchObject({ visibility: "private" });
    expect([...added.item.assignees].sort()).toEqual([ana.email, ben.email]);

    // The person who started it gets no special place. Once Ana
    // unsubscribes, only Ben is assigned.
    await getDb()
      .update(juniorConversationParticipants)
      .set({ unsubscribedAt: new Date("2026-10-01T12:10:00.000Z") })
      .where(eq(juniorConversationParticipants.userId, ana.id));
    const left = await execute(eventTurn("local:web:shared").add, ask);
    expect(left.item.assignees).toEqual([ben.email]);

    // With no Participant, no person would see the item.
    await conversation("slack:CPUB:1.000001", "CPUB", "public");
    await expect(
      execute(eventTurn("slack:CPUB:1.000001").add, ask),
    ).rejects.toThrow("Only people act on items");
    const everyone = await execute(eventTurn("slack:CPUB:1.000001").add, {
      ...ask,
      assignees: ["everyone"],
    });
    expect(everyone.item.assignees).toEqual(["everyone"]);

    // A Slack app that mentions Junior can have a User, and it is then a
    // Participant. It is not a person, so it gets no item.
    const app = await user("alerts@example.com");
    await conversation("slack:CPUB:1.000002", "CPUB", "public");
    await getDb()
      .insert(juniorConversationParticipants)
      .values({
        lastMessageAt: new Date("2026-10-01T12:05:00.000Z"),
        rootConversationId: "slack:CPUB:1.000002",
        userId: app.id,
      });
    const appTurn = tools({
      actorIsApp: true,
      conversationId: "slack:CPUB:1.000002",
      resolveActorIdentity: asActor(app),
      source: { kind: "slack" } as any,
    });
    const before = await getDb()
      .select({ id: juniorInboxItems.id })
      .from(juniorInboxItems);
    await expect(execute(appTurn.add, ask)).rejects.toThrow(
      "Only people act on items",
    );
    expect(
      await getDb().select({ id: juniorInboxItems.id }).from(juniorInboxItems),
    ).toEqual(before);
  });

  it("lets an agent close an item once, with a reason", async () => {
    await conversation("slack:CPUB:1.000001", "CPUB", "public");
    await conversation("slack:CPUB:1.000002", "CPUB", "public");
    await user("ana@example.com");
    const agent = tools(automationRun("slack:CPUB:1.000001"));
    const added = await execute(agent.add, {
      kind: "notice",
      title: "Pull request needs review",
      body: "It waits on a reviewer.",
      assignees: ["everyone"],
      conversation_ids: ["slack:CPUB:1.000002"],
    });

    await expect(
      execute(agent.update, { id: added.item.id, status: "done" }),
    ).rejects.toThrow("Give a `reason`");
    // The close committed, but its messages did not go out. A retry of the
    // same close sends them.
    await closeInboxItem(getDb(), {
      id: added.item.id,
      nowMs: Date.now(),
      reason: "no longer needed: pull request closed",
      status: "dismissed",
    });
    const retry = () =>
      execute(agent.update, {
        id: added.item.id,
        status: "dismissed",
        reason: "no longer needed: pull request closed",
      });
    await retry();
    const closed = await retry();
    expect(closed).not.toHaveProperty("already_closed");
    expect(closed.item).toMatchObject({
      status: "dismissed",
      closed_by: "agent",
      close_reason: "no longer needed: pull request closed",
    });
    // Only the other linked Conversation hears about the close, once.
    const other = await getConversation({
      conversationId: "slack:CPUB:1.000002",
    });
    expect(
      other?.execution.pendingMessages.map((message) => message.input.text),
    ).toEqual([expect.stringContaining("An agent in another Conversation")]);
    const own = await getConversation({
      conversationId: "slack:CPUB:1.000001",
    });
    expect(own?.execution.pendingMessages ?? []).toEqual([]);
    // A later close with another status keeps the first close.
    const again = await execute(agent.update, {
      id: added.item.id,
      status: "done",
      reason: "again",
    });
    expect(again).toEqual({ already_closed: true, item: closed.item });
    expect((await execute(agent.search, {})).count).toBe(0);
    expect((await execute(agent.search, { status: "any" })).count).toBe(1);
  });

  it("keeps a person's close when the agent closes the item after them", async () => {
    await conversation("slack:CPUB:1.000001", "CPUB", "public");
    await conversation("slack:CPUB:1.000002", "CPUB", "public");
    const ana = await user("ana@example.com");
    const context = automationRun("slack:CPUB:1.000001");
    const shown: string[] = [];
    const agent = {
      ...tools(context),
      update: createUpdateInboxItemTool(context, {
        ...services,
        show: async (itemId) => {
          shown.push(itemId);
        },
      }),
    };
    const added = await execute(agent.add, {
      kind: "action",
      title: "Approve the entry?",
      body: "It waits on a decision.",
      assignees: [ana.email],
      conversation_ids: ["slack:CPUB:1.000002"],
      request: REQUEST,
    });
    await actOnInboxItem({
      action: "submit",
      answer: { requestId: added.item.id, values: { decision: ["Approve"] } },
      delivery: { queue, show: async () => {} },
      id: added.item.id,
      user: ana,
    });
    const pending = async () =>
      await Promise.all(
        ["slack:CPUB:1.000001", "slack:CPUB:1.000002"].map(
          async (conversationId) =>
            (await getConversation({ conversationId }))?.execution
              .pendingMessages ?? [],
        ),
      );
    const answered = await getInboxItem(getDb(), added.item.id);
    const before = await pending();

    // Ana answered it, and then the agent closes it, with any status.
    const done = await execute(agent.update, {
      id: added.item.id,
      status: "done",
      reason: "the entry was approved",
    });
    expect(done.already_closed).toBe(true);
    expect(done.item).toMatchObject({
      status: "done",
      closed_by: ana.email,
      answer: { values: { decision: ["Approve"] } },
    });
    expect(done.item).not.toHaveProperty("close_reason");
    const dismissed = await execute(agent.update, {
      id: added.item.id,
      status: "dismissed",
      reason: "no longer needed",
    });
    expect(dismissed).toEqual(done);
    expect(await getInboxItem(getDb(), added.item.id)).toEqual(answered);
    expect(await pending()).toEqual(before);
    expect(shown).toEqual([]);

    // An edit of a closed item still fails.
    await expect(
      execute(agent.update, { id: added.item.id, body: "New body." }),
    ).rejects.toThrow("is already closed");
    // A Conversation that cannot change the item still gets that error.
    await conversation("slack:CPRIV:1.000001", "CPRIV", "private");
    const privateAgent = tools({
      conversationId: "slack:CPRIV:1.000001",
      resolveActorIdentity: asActor(ana),
      source: { kind: "slack" } as any,
    });
    await expect(
      execute(privateAgent.update, {
        id: added.item.id,
        status: "done",
        reason: "the entry was approved",
      }),
    ).rejects.toThrow("A public item changes only from a public Conversation");
  });

  it("leaves Automation alerts to core", async () => {
    await conversation("slack:CPUB:1.000001", "CPUB", "public");
    const ana = await user("ana@example.com");
    const agent = tools(automationRun("slack:CPUB:1.000001"));
    const notice = {
      kind: "notice",
      title: "Digest failed",
      body: "The last run failed.",
      assignees: ["everyone"],
    };
    // An alert that core added for an Automation of a public channel.
    await getDb()
      .insert(juniorIdentities)
      .values({
        createdAt: new Date(1),
        id: "identity:creator",
        kind: "user",
        provider: "slack",
        providerSubjectId: "UCREATOR",
        providerTenantId: "T123",
        updatedAt: new Date(1),
        userId: ana.id,
      });
    await getDb()
      .insert(juniorAutomations)
      .values({
        channelId: "CPUB",
        createdAtMs: 1,
        creatorIdentityId: "identity:creator",
        creatorSlackUserId: "UCREATOR",
        id: "sched_1",
        instruction: "Post the digest.",
        kind: "scheduled",
        record: {} as any,
        status: "active",
        teamId: "T123",
      });
    const alert = await insertInboxItem(getDb(), {
      assignedToEveryone: false,
      assigneeUserIds: [ana.id],
      body: "Last run failed.",
      conversationIds: [],
      kind: "action",
      nowMs: Date.now(),
      owner: { id: "sched_1", kind: "automation" },
      subject: { id: "sched_1", kind: "automation" },
      title: "Daily digest",
    });
    // An agent's question is its own item, not the Automation's alert.
    const own = await execute(agent.add, notice);
    expect(own.item.id).not.toBe(alert!.id);
    await expect(
      execute(agent.update, {
        id: alert!.id,
        status: "dismissed",
        reason: "fixed",
      }),
    ).rejects.toThrow("It is an Automation alert");
    expect(await getInboxItem(getDb(), alert!.id)).toMatchObject({
      status: "open",
    });
  });
});
