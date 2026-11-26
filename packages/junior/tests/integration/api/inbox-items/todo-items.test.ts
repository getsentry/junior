import type { Event, User } from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inboxItemCountSchema, inboxItemListSchema } from "@/api/schema";
import { createEventAppPublisher } from "@/chat/events/app-publisher";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import { getInboxItem } from "@/chat/inbox-items/store";
import { waitingConversationIdsQuery } from "@/chat/inbox-items/waiting";
import { createSlackInboxItemToolServices } from "@/chat/slack/inbox-item-tools";
import { setTodoStatusByUser } from "@/chat/todos/store";
import { createUpdateTodosTool } from "@/chat/todos/tools/update";
import {
  juniorConversationParticipants,
  juniorConversations,
} from "@/db/schema";
import {
  closeConversationFixture,
  createConversationFixture,
  type ConversationFixture,
} from "../../../fixtures/conversation";
import { useGitHubEvents } from "../../../fixtures/event-automations";
import {
  addPullRequestItem,
  api,
  conversation,
  linkGitHub,
  NOW_MS,
  OTHER_PULL_REQUEST,
  PRIVATE_ROOT,
  ROOT,
  useGitHubRepository,
  user,
} from "../../../fixtures/snoozes";

const HOUR_MS = 60 * 60 * 1000;
const THREAD = "agent:thread-of-snooze-root";

describe("To-dos for a person in the Inbox", () => {
  let fixture: ConversationFixture;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    fixture = await createConversationFixture();
    await conversation(ROOT, "public");
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await closeConversationFixture();
  });

  /** The `updateTodos` tool of the agent in one Conversation. */
  function agentTodos(conversationId: string) {
    const tool = createUpdateTodosTool(
      { conversationId },
      createSlackInboxItemToolServices(() => fixture.queue).findMentionedUserId,
    );
    return async (input: unknown) =>
      (await tool.execute!(tool.prepareArguments!(input) as never, {})) as {
        todos: { id: string }[];
      };
  }

  /** What one person's Inbox shows: its items and its counts. */
  function inbox(viewer: User) {
    const asViewer = api(fixture, viewer);
    const read = async (path: string) =>
      await (await asViewer.request(path)).json();
    return {
      ...asViewer,
      count: async () =>
        inboxItemCountSchema.parse(
          await read("/inbox-items/count?include=snoozed"),
        ),
      items: async (query = "for=viewer") =>
        inboxItemListSchema.parse(await read(`/inbox-items?${query}`)).items,
    };
  }

  it("shows a To-do for a person only in their Inbox, and Done closes the To-do", async () => {
    const ana = await user("ana@example.com");
    const bob = await user("bob@example.com");
    const updateTodos = agentTodos(ROOT);
    const added = await updateTodos({
      add: [
        { title: "Write the brief" },
        {
          title: "Confirm the rollback window",
          notes: "Check the deploy calendar.",
          assignee: "ana@example.com",
        },
      ],
    });
    const todoId = Number(added.todos[1]!.id.replace("TODO-", ""));
    const asAna = inbox(ana);
    const asBob = inbox(bob);

    const [item] = await asAna.items();
    expect(item).toEqual(
      expect.objectContaining({
        body: "Check the deploy calendar.",
        canAct: true,
        canTake: false,
        conversationIds: [],
        kind: "action",
        owner: { id: ROOT, kind: "conversation" },
        rootConversationId: ROOT,
        status: "open",
        title: "Confirm the rollback window",
        todoId,
      }),
    );
    expect(await asAna.items()).toHaveLength(1);
    // It counts as Needs you, as a To-do, and in the tab count, and the
    // Conversation waits on Ana.
    expect(await asAna.count()).toEqual(
      expect.objectContaining({
        decisions: 0,
        needsViewer: 1,
        snoozed: 0,
        todos: 1,
      }),
    );
    expect(
      (await waitingConversationIdsQuery(getDb(), ana.id)).map(
        (row) => row.conversationId,
      ),
    ).toContain(ROOT);

    // The Conversation is public, but the To-do is Ana's alone.
    expect(await asBob.items()).toEqual([]);
    expect(await asBob.items(`q=rollback`)).toEqual([]);
    expect(await asBob.items(`conversationId=${ROOT}`)).toEqual([]);
    expect((await asBob.request(`/inbox-items/${item!.id}`)).status).toBe(404);
    expect((await asBob.act(item!.id, { action: "done" })).status).toBe(404);
    expect(await asBob.count()).toEqual(
      expect.objectContaining({ needsViewer: 0 }),
    );
    // The Conversation waits on Ana alone. Its shared status does not
    // change, so it does not show as waiting to Bob.
    const detail = async (viewer: typeof asAna) =>
      await (await viewer.request(`/conversations/${ROOT}`)).json();
    expect(await detail(asAna)).toEqual(
      expect.objectContaining({ status: "done", treeState: "needs_you" }),
    );
    expect(await detail(asBob)).toEqual(
      expect.objectContaining({ status: "done", treeState: "done" }),
    );

    // Done or Dismiss closes it. Take and answers are for other items.
    expect((await asAna.act(item!.id, { action: "take" })).status).toBe(400);

    const done = await asAna.act(item!.id, { action: "done" });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual(
      expect.objectContaining({
        closedBy: expect.objectContaining({ userId: ana.id }),
        status: "done",
        todoId,
      }),
    );
    // A retry of the same Done succeeds.
    expect((await asAna.act(item!.id, { action: "done" })).status).toBe(200);
    expect(await asAna.items()).toEqual([]);
    expect(await asAna.count()).toEqual(
      expect.objectContaining({ needsViewer: 0 }),
    );
    const todos = (await (
      await asAna.request(`/conversations/${ROOT}/todos`)
    ).json()) as {
      todos: { id: number; status: string; changedBy?: string }[];
    };
    expect(todos.todos.find((todo) => todo.id === todoId)).toEqual(
      expect.objectContaining({ changedBy: "ana@example.com", status: "done" }),
    );

    // When the agent reopens it, it waits on Ana again.
    await updateTodos({ update: [{ id: `TODO-${todoId}`, status: "open" }] });
    const [reopened] = await asAna.items();
    expect(reopened).toEqual(expect.objectContaining({ todoId }));
    expect(reopened!.id).not.toBe(item!.id);
  });

  it("Dismiss drops the To-do", async () => {
    const ana = await user("ana@example.com");
    const updateTodos = agentTodos(ROOT);
    const {
      todos: [todo],
    } = await updateTodos({
      add: [{ title: "Pick a launch date", assignee: "ana@example.com" }],
    });
    const asAna = inbox(ana);
    const [item] = await asAna.items();

    const dismissed = await asAna.act(item!.id, { action: "dismiss" });
    expect(dismissed.status).toBe(200);
    expect(await dismissed.json()).toEqual(
      expect.objectContaining({
        closedBy: expect.objectContaining({ userId: ana.id }),
        status: "dismissed",
      }),
    );
    // A retry of the same Dismiss succeeds, but Done does not undo it.
    expect((await asAna.act(item!.id, { action: "dismiss" })).status).toBe(200);
    expect((await asAna.act(item!.id, { action: "done" })).status).toBe(409);
    expect(await asAna.items()).toEqual([]);
    expect(await todoState(todo!.id)).toEqual(
      expect.objectContaining({
        changedBy: "ana@example.com",
        status: "dropped",
      }),
    );
  });

  it("a resolve trigger marks the To-do done, alone and in a stack", async () => {
    await useGitHubEvents();
    useGitHubRepository(["ana-gh"]);
    const ana = await linkGitHub(await user("ana@example.com"), "ana-gh");
    const asAna = inbox(ana);
    const merged = async () =>
      await publisher().publish(otherPullRequestMerged());
    const resolveOnMerge = (subject: {
      conversationId: string;
      inboxItemId?: string;
    }) =>
      asAna.snoozeOn(subject, [
        {
          eventType: "pull_request.merged",
          outcome: "resolve",
          resourceUrl: OTHER_PULL_REQUEST.url,
        },
      ]);
    const updateTodos = agentTodos(ROOT);

    // One To-do row.
    const {
      todos: [alone],
    } = await updateTodos({
      add: [
        { title: "Confirm the rollback window", assignee: "ana@example.com" },
      ],
    });
    const [item] = await asAna.items();
    const snoozed = await resolveOnMerge({
      conversationId: ROOT,
      inboxItemId: item!.id,
    });
    expect(snoozed.status).toBe(201);
    expect(await snoozed.json()).toEqual({ inboxItemIds: [item!.id] });
    await merged();
    expect(await todoState(alone!.id)).toEqual(
      expect.objectContaining({ changedBy: "ana@example.com", status: "done" }),
    );
    expect(await getInboxItem(getDb(), item!.id)).toEqual(
      expect.objectContaining({ status: "done" }),
    );
    expect(await asAna.items()).toEqual([]);

    // A stack with a To-do and another ask: the ask is dismissed, and the
    // To-do is done.
    const {
      todos: [stacked],
    } = await updateTodos({
      add: [{ title: "Approve the copy", assignee: "ana@example.com" }],
    });
    const review = await addPullRequestItem(ROOT, [ana], "Review acme entry");
    expect(await asAna.items()).toHaveLength(2);
    expect((await resolveOnMerge({ conversationId: ROOT })).status).toBe(201);
    expect(await asAna.items()).toEqual([]);
    await merged();
    expect(await todoState(stacked!.id)).toEqual(
      expect.objectContaining({ changedBy: "ana@example.com", status: "done" }),
    );
    expect((await getInboxItem(getDb(), review))?.status).toBe("dismissed");
    expect(await asAna.items()).toEqual([]);
    expect(await asAna.count()).toEqual(
      expect.objectContaining({ needsViewer: 0, snoozed: 0 }),
    );
  });

  it("follows the To-do as the agent changes it", async () => {
    const ana = await user("ana@example.com");
    const bob = await user("bob@example.com");
    const updateTodos = agentTodos(ROOT);
    const {
      todos: [todo],
    } = await updateTodos({
      add: [{ title: "Pick a launch date", assignee: "ana@example.com" }],
    });
    const asAna = inbox(ana);
    const asBob = inbox(bob);
    const [first] = await asAna.items();

    await updateTodos({
      update: [{ id: todo!.id, title: "Pick a launch week", notes: "Q1" }],
    });
    expect(await asAna.items()).toEqual([
      expect.objectContaining({
        body: "Q1",
        id: first!.id,
        title: "Pick a launch week",
      }),
    ]);

    await updateTodos({
      update: [{ id: todo!.id, assignee: "bob@example.com" }],
    });
    expect(await asAna.items()).toEqual([]);
    expect(await asBob.items()).toEqual([
      expect.objectContaining({ id: first!.id, title: "Pick a launch week" }),
    ]);
    // Done that Ana sent before the move does not close Bob's To-do.
    expect(
      await setTodoStatusByUser(getSqlExecutor(), {
        assignedOnly: true,
        conversationId: ROOT,
        id: Number(todo!.id.replace("TODO-", "")),
        nowMs: NOW_MS,
        status: "done",
        userId: ana.id,
      }),
    ).toBeUndefined();
    expect(await asBob.items()).toHaveLength(1);

    // Work that moves to the agent, or that it drops, leaves the Inbox.
    await updateTodos({ update: [{ id: todo!.id, assignee: "self" }] });
    expect(await asBob.items()).toEqual([]);
    await updateTodos({
      update: [{ id: todo!.id, assignee: "bob@example.com" }],
    });
    expect(await asBob.items()).toHaveLength(1);
    await updateTodos({ update: [{ id: todo!.id, status: "dropped" }] });
    expect(await asBob.items()).toEqual([]);
    expect(
      await asBob.items("for=viewer&status=done,dismissed"),
    ).toContainEqual(
      expect.objectContaining({
        closeReason: "The To-do was dropped.",
        status: "dismissed",
      }),
    );
  });

  it("snoozes a To-do with its Conversation's stack", async () => {
    const ana = await user("ana@example.com");
    await updateTodosFor(ROOT, "Confirm the rollback window");
    const asAna = inbox(ana);
    const [item] = await asAna.items();

    // One row.
    expect(
      (
        await asAna.snooze(
          { conversationId: ROOT, inboxItemId: item!.id },
          NOW_MS + HOUR_MS,
        )
      ).status,
    ).toBe(201);
    expect(await asAna.items()).toEqual([]);
    expect(await asAna.count()).toEqual(
      expect.objectContaining({ needsViewer: 0, snoozed: 1 }),
    );
    expect((await asAna.unsnooze({ conversationId: ROOT })).status).toBe(204);
    expect(await asAna.items()).toHaveLength(1);

    // The stack, with a To-do of a child agent in it.
    await conversationThread();
    await updateTodosFor(THREAD, "Approve the copy");
    expect(await asAna.items()).toHaveLength(2);
    expect(
      (await asAna.snooze({ conversationId: ROOT }, NOW_MS + HOUR_MS)).status,
    ).toBe(201);
    expect(await asAna.items()).toEqual([]);
    expect(await asAna.count()).toEqual(
      expect.objectContaining({ needsViewer: 0, snoozed: 2 }),
    );
  });

  it("goes only to a person who can see the Conversation", async () => {
    await conversation(PRIVATE_ROOT, "private");
    const ana = await user("ana@example.com");
    const bob = await user("bob@example.com");
    await getDb()
      .insert(juniorConversationParticipants)
      .values({
        lastMessageAt: new Date(NOW_MS),
        rootConversationId: PRIVATE_ROOT,
        userId: ana.id,
      });
    await agentTodos(PRIVATE_ROOT)({
      add: [
        { title: "Rotate the key", assignee: "ana@example.com" },
        { title: "Rotate the other key", assignee: "bob@example.com" },
      ],
    });
    const [item] = await inbox(ana).items();
    expect(item).toEqual(expect.objectContaining({ title: "Rotate the key" }));
    expect(await inbox(bob).items()).toEqual([]);

    // A root with no stored root id is its own root, so Ana still sees it.
    await getDb()
      .update(juniorConversations)
      .set({ rootConversationId: null, topLevelConversationId: null })
      .where(eq(juniorConversations.conversationId, PRIVATE_ROOT));
    expect(await inbox(ana).items()).toEqual([
      expect.objectContaining({ title: "Rotate the key" }),
    ]);
    expect(await inbox(ana).count()).toEqual(
      expect.objectContaining({ needsViewer: 1 }),
    );

    // When Ana leaves the Conversation, the item leaves her Inbox too.
    await getDb()
      .delete(juniorConversationParticipants)
      .where(eq(juniorConversationParticipants.userId, ana.id));
    expect(await inbox(ana).items()).toEqual([]);
    expect(await inbox(ana).count()).toEqual(
      expect.objectContaining({ needsViewer: 0 }),
    );
    expect((await inbox(ana).act(item!.id, { action: "done" })).status).toBe(
      404,
    );
  });

  function publisher() {
    return createEventAppPublisher({
      conversationWork: () => ({ queue: fixture.queue }),
    });
  }

  /** A GitHub Event: `OTHER_PULL_REQUEST` merged. */
  function otherPullRequestMerged(): Event {
    return {
      eventKey: `pull_request.merged:${OTHER_PULL_REQUEST.identifier}`,
      eventType: "pull_request.merged",
      identifier: OTHER_PULL_REQUEST.identifier,
      namespace: "github",
      occurredAtMs: Date.now(),
      trustedSummary: "Pull request merged.",
    };
  }

  /** A To-do of `ROOT`, as the Conversation's To-do list shows it. */
  async function todoState(ref: string) {
    const { todos } = (await (
      await api(fixture, await user("ana@example.com")).request(
        `/conversations/${ROOT}/todos`,
      )
    ).json()) as {
      todos: { id: number; status: string; changedBy?: string }[];
    };
    return todos.find((todo) => `TODO-${todo.id}` === ref);
  }

  async function updateTodosFor(conversationId: string, title: string) {
    await agentTodos(conversationId)({
      add: [{ title, assignee: "ana@example.com" }],
    });
  }

  async function conversationThread() {
    await getConversationStore().createChild({
      childConversationId: THREAD,
      kind: "thread",
      nowMs: NOW_MS,
      parentConversationId: ROOT,
      title: "Check the copy",
    });
  }
});
