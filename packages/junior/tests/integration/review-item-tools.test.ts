import type { Identity, User } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { closeReviewItem } from "@/chat/review-items/store";
import {
  juniorAutomations,
  juniorConversationParticipants,
  juniorIdentities,
} from "@/db/schema";
import {
  createAddReviewItemTool,
  createSearchReviewItemsTool,
  createUpdateReviewItemTool,
} from "@/chat/tools/review-items";
import { createSlackReviewItemToolServices } from "@/chat/slack/review-item-tools";
import { getConversation } from "@/chat/task-execution/store";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";

type Context = Pick<
  ToolRuntimeContext,
  "conversationId" | "resolveActorIdentity" | "source"
>;

async function execute(tool: any, input: unknown): Promise<any> {
  return await tool.execute(input, {} as any);
}

const queue = createConversationWorkQueueTestAdapter();

const services = createSlackReviewItemToolServices(() => queue);

function tools(context: Context) {
  return {
    add: createAddReviewItemTool(context, services),
    search: createSearchReviewItemsTool(context, services),
    update: createUpdateReviewItemTool(context, services),
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

function automationRun(conversationId: string): Context {
  return {
    conversationId,
    resolveActorIdentity: asActor(undefined),
    source: { kind: "scheduled_automation" },
  };
}

describe("review item tools", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("updates one open item per dedupe key across Automation runs", async () => {
    await conversation("slack:CPUB:1.000001", "CPUB", "public");
    await conversation("slack:CPUB:1.000002", "CPUB", "public");
    const ana = await user("ana@example.com");
    await user("ben@example.com");
    const first = tools(automationRun("slack:CPUB:1.000001"));
    const second = tools(automationRun("slack:CPUB:1.000002"));
    const add = {
      kind: "action",
      title: "Review acme entry",
      body: "The acme entry changed its license.",
      assignees: ["ana@example.com", "ben@example.com"],
      dedupe_key: "fair-source:entry:acme",
      request: REQUEST,
      subject: { id: "https://github.com/example/list/pull/7" },
    };

    await expect(
      execute(first.add, { ...add, request: undefined }),
    ).rejects.toThrow("An action item needs a `request`.");
    const added = await execute(first.add, add);
    const again = await execute(second.add, {
      ...add,
      title: "Review acme entry again",
      assignees: ["ana@example.com"],
    });

    expect(added.created).toBe(true);
    expect(again).toMatchObject({
      created: false,
      item: {
        id: added.item.id,
        title: "Review acme entry again",
        assignees: ["ana@example.com"],
        conversation_ids: ["slack:CPUB:1.000001", "slack:CPUB:1.000002"],
        visibility: "public",
      },
    });

    // A person in another public Conversation finds it by subject.
    await conversation("slack:COTHER:1.000003", "COTHER", "public");
    const reader = tools({
      conversationId: "slack:COTHER:1.000003",
      resolveActorIdentity: asActor(ana),
      source: { kind: "web", conversationId: "web:1" } as any,
    });
    const found = await execute(reader.search, {
      subject_id: "https://github.com/example/list/pull/7",
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
    ).rejects.toThrow("<@U999> has no Junior user yet");

    // A public item stays inside its Slack workspace.
    await conversation("slack:CFAR:1.000004", "CFAR", "public", "T999");
    // Ana is assigned, but an agent there still cannot read or change it.
    const outsider = tools({
      conversationId: "slack:CFAR:1.000004",
      resolveActorIdentity: asActor(ana),
      source: { kind: "slack" } as any,
    });
    expect((await execute(outsider.search, {})).count).toBe(0);
    // Dedupe keys are per workspace, so the same key is a new item there.
    const theirs = await execute(outsider.add, add);
    expect(theirs.created).toBe(true);
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
      dedupe_key: "deploy-key",
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
    await expect(
      execute(other.add, { ...notice, assignees: ["ben@example.com"] }),
    ).rejects.toThrow("Another open item uses this `dedupe_key`");
    // A private Conversation cannot write into a public item, by its key
    // or by an update, because other Conversations read that item.
    const shared = await execute(other.add, {
      ...notice,
      dedupe_key: "shared-key",
      assignees: ["everyone"],
    });
    await expect(
      execute(owner.add, {
        ...notice,
        dedupe_key: "shared-key",
        assignees: ["ana@example.com"],
      }),
    ).rejects.toThrow("Use a different key.");
    await expect(
      execute(owner.update, { id: shared.item.id, body: "Private detail." }),
    ).rejects.toThrow("A public item changes only from a public Conversation");
    // Nor can he link a private Conversation that he cannot see.
    await expect(
      execute(other.add, {
        ...notice,
        dedupe_key: "other-key",
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
    const notice = {
      kind: "notice",
      title: "Digest needs a look",
      body: "Two entries changed.",
      assignees: ["ana@example.com"],
      dedupe_key: "digest",
    };

    // A new run has no Actor and no people yet. It can still assign the
    // creator of its Automation, but nobody else.
    await conversation("slack:DRUN:1.000003", "DRUN", "private");
    await user("ben@example.com");
    const fresh = await execute(run("slack:DRUN:1.000003").add, {
      ...notice,
      dedupe_key: "digest-fresh",
    });
    expect(fresh.item.assignees).toEqual(["ana@example.com"]);
    await expect(
      execute(run("slack:DRUN:1.000003").add, {
        ...notice,
        assignees: ["ben@example.com"],
        dedupe_key: "digest-other",
      }),
    ).rejects.toThrow("only to people in its Conversation");

    const added = await execute(run("slack:DRUN:1.000001").add, notice);
    // Ana took part only in the first run, which added the item.
    const again = await execute(run("slack:DRUN:1.000002").add, notice);
    expect(again).toMatchObject({
      created: false,
      item: { id: added.item.id, assignees: ["ana@example.com"] },
    });

    // A run in a private Conversation cannot write into the public item of
    // an earlier run, by its key or by an update.
    await conversation("slack:CPUB:1.000009", "CPUB", "public");
    const shared = await execute(run("slack:CPUB:1.000009").add, {
      ...notice,
      assignees: ["everyone"],
      dedupe_key: "digest-public",
    });
    expect(shared.item.visibility).toBe("public");
    await expect(
      execute(run("slack:DRUN:1.000002").add, {
        ...notice,
        dedupe_key: "digest-public",
      }),
    ).rejects.toThrow("Use a different key.");
    await expect(
      execute(run("slack:DRUN:1.000002").update, {
        id: shared.item.id,
        body: "Private detail.",
      }),
    ).rejects.toThrow("A public item changes only from a public Conversation");
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
      dedupe_key: "pr:7",
    });

    await expect(
      execute(agent.update, { id: added.item.id, status: "done" }),
    ).rejects.toThrow("Give a `reason`");
    // The close committed, but its messages did not go out. A retry of the
    // same close sends them.
    await closeReviewItem(getDb(), {
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
    await expect(
      execute(agent.update, {
        id: added.item.id,
        status: "done",
        reason: "again",
      }),
    ).rejects.toThrow("is already closed");
    expect((await execute(agent.search, {})).count).toBe(0);
    expect((await execute(agent.search, { status: "any" })).count).toBe(1);

    // A closed key can start a new item.
    const next = await execute(agent.add, {
      kind: "notice",
      title: "Pull request needs review",
      body: "It reopened.",
      assignees: ["everyone"],
      dedupe_key: "pr:7",
    });
    expect(next.created).toBe(true);
  });
});
