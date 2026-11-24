import type { Identity, User } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resultAuthorId } from "@/chat/agent-invocations/result-actors";
import type { AgentRun } from "@/chat/agent/types";
import { webActorFromUser } from "@/chat/conversations/web-input";
import { getConversationEventStore, getDb } from "@/chat/db";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import {
  actOnInboxItem,
  closeInboxItemsAnsweredByReply,
} from "@/chat/inbox-items/actions";
import {
  closeInboxItem,
  INBOX_ITEM_REPLIED_REASON,
} from "@/chat/inbox-items/store";
import { createAddInboxItemTool } from "@/chat/inbox-items/tools/add";
import { createSlackInboxItemToolServices } from "@/chat/slack/inbox-item-tools";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { slackParentConversationId } from "../fixtures/agent-invocations";
import { signedInViewer } from "../fixtures/user";
import {
  createHarness,
  finishRun,
  startThread,
  type Harness,
} from "../fixtures/thread-input";

const QUESTION = "Delete the preview-42 deployment?";

async function parentMessages() {
  return (
    (
      await getConversationWorkState({
        conversationId: slackParentConversationId,
      })
    )?.messages ?? []
  );
}

async function childMessages(childId: string) {
  return (
    (await getConversationWorkState({ conversationId: childId }))?.messages ??
    []
  );
}

/**
 * Run the Task's first Turn: it asks the person with `addInboxItem`, as the
 * agent would, then ends with `noReply`. The item also links the root.
 */
async function askInTask(
  harness: Harness,
  childId: string,
  person: User,
  afterAsk?: (itemId: string) => Promise<void>,
): Promise<string> {
  let itemId: string | undefined;
  harness.onRun(async (run: AgentRun) => {
    const add = createAddInboxItemTool(
      {
        conversationId: run.conversationId,
        resolveActorIdentity: async () => ({
          identity: { id: `identity:${person.id}` } as Identity,
          user: person,
        }),
        source: run.source,
        turnId: run.turnId,
      },
      createSlackInboxItemToolServices(() => harness.queue),
    );
    const added = await add.execute!(
      add.prepareArguments!({
        kind: "action",
        title: "Delete preview-42",
        body: "The Task needs approval to delete preview-42.",
        conversation_ids: [slackParentConversationId],
        request: {
          question: QUESTION,
          fields: [
            {
              id: "decision",
              kind: "choice",
              label: "Decision",
              options: [{ label: "Delete" }, { label: "Keep" }],
            },
          ],
        },
      }) as never,
      { toolCallId: "ask-1" } as never,
    );
    itemId = (added as { item: { id: string } }).item.id;
    await afterAsk?.(itemId);
    return await finishRun(run, { noReply: {} });
  });
  await harness.drain(childId);
  harness.onRun(undefined);
  if (!itemId) throw new Error("the Task added no item");
  return itemId;
}

describe("a child agent asks a person", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
  });

  it("sends the answer only to the Task that asked, which runs it as the person", async () => {
    const harness = await createHarness();
    try {
      const person = await signedInViewer("maya@example.com");
      const childId = await startThread(harness, "task-spawn", {
        kind: "task",
      });

      const itemId = await askInTask(harness, childId, person);

      // The parent learns that the child waits on a person, and gets no
      // completed result for the Turn that ended with `noReply`.
      const waiting = await parentMessages();
      expect(waiting.map((message) => message.input.text)).toEqual([
        expect.stringMatching(/status="waiting"[\s\S]*Delete the preview-42/),
      ]);

      await actOnInboxItem({
        action: "submit",
        answer: { requestId: itemId, values: { decision: ["Delete"] } },
        delivery: { queue: harness.queue, show: async () => {} },
        id: itemId,
        user: person,
      });

      // The root that the item links only records the answer. It gets no
      // input that would start a Turn.
      expect(await parentMessages()).toHaveLength(1);
      const rootEvents = await getConversationEventStore().query(
        slackParentConversationId,
        { limit: 20, types: ["message", "message_handled"] },
      );
      expect(
        rootEvents.events.map((event) => [
          event.data.type,
          "messageId" in event.data ? event.data.messageId : undefined,
        ]),
      ).toEqual([
        ["message", `inbox-item:${itemId}:closed`],
        ["message_handled", `inbox-item:${itemId}:closed`],
      ]);
      // The Task gets the answer as the person's own input.
      expect(await childMessages(childId)).toEqual([
        expect.objectContaining({ source: "web" }),
      ]);

      let answerRun: AgentRun | undefined;
      harness.onRun(async (run) => {
        answerRun = run;
        return await finishRun(run, {
          reply: { text: "Deleted preview-42.", toolCallId: "reply-1" },
        });
      });
      await harness.drain(childId);

      expect(answerRun).toMatchObject({
        actor: webActorFromUser(person),
        conversationId: childId,
        source: { kind: "web" },
      });
      expect(answerRun?.instruction.text).toContain(
        `<inbox-item-answer id="${itemId}">`,
      );
      // The person's Turn reports to the parent as the Event system Actor,
      // so the parent never gets the person's access.
      const result = (await parentMessages()).at(-1);
      expect(result?.input.text).toContain("Deleted preview-42.");
      expect(result?.input.authorId).toBe(resultAuthorId(EVENT_SYSTEM_ACTOR));
    } finally {
      await harness.close();
    }
  });

  it("sends a reply in the root's thread that answers a child's card only to that child", async () => {
    const harness = await createHarness();
    try {
      const person = await signedInViewer("maya@example.com");
      const childId = await startThread(harness, "task-reply", {
        kind: "task",
      });
      const itemId = await askInTask(harness, childId, person);
      // Which open item a reply answers is a decision model choice, which
      // the classifier eval checks. Here the reply already closed the item,
      // as when its first delivery did not finish, so no decision runs.
      await closeInboxItem(getDb(), {
        answer: { other: "Keep it.", requestId: itemId, values: {} },
        closedByUserId: person.id,
        id: itemId,
        nowMs: Date.now(),
        reason: INBOX_ITEM_REPLIED_REASON,
        status: "done",
      });

      await closeInboxItemsAnsweredByReply({
        conversationId: slackParentConversationId,
        delivery: { queue: harness.queue, show: async () => {} },
        resolveUser: async () => person,
        text: "Keep it.",
      });

      // The root already has the reply as its own input, so it gets only
      // the `waiting` update. The child gets the answer as the person's.
      expect(await parentMessages()).toHaveLength(1);
      expect(await childMessages(childId)).toEqual([
        expect.objectContaining({ source: "web" }),
      ]);
      let answerRun: AgentRun | undefined;
      harness.onRun(async (run) => {
        answerRun = run;
        return await finishRun(run, { noReply: {} });
      });
      await harness.drain(childId);
      expect(answerRun).toMatchObject({
        actor: webActorFromUser(person),
        conversationId: childId,
      });
      expect(answerRun?.instruction.text).toContain(
        `<inbox-item-answer id="${itemId}">`,
      );
      expect(answerRun?.instruction.text).toContain("Keep it.");
    } finally {
      await harness.close();
    }
  });

  it("tells the parent when a person dismisses its child's item", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const person = await signedInViewer("maya@example.com");
      const childId = await startThread(harness, "task-dismiss", {
        kind: "task",
      });
      const itemId = await askInTask(harness, childId, person);

      await actOnInboxItem({
        action: "dismiss",
        delivery: { queue: harness.queue, show: async () => {} },
        id: itemId,
        user: person,
      });

      // The child learns of it as a root owner does, with no Turn. Its work
      // ended, so the parent gets its result and stops waiting on it.
      expect(await childMessages(childId)).toEqual([]);
      const messages = await parentMessages();
      expect(messages.map((message) => message.input.text)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/status="waiting"/),
          expect.stringMatching(
            /status="completed"[\s\S]*dismissed inbox item "Delete preview-42"/,
          ),
        ]),
      );
      expect(messages).toHaveLength(2);
      expect(
        messages.every(
          (message) =>
            message.input.authorId === resultAuthorId(EVENT_SYSTEM_ACTOR),
        ),
      ).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("reports a dismiss during the asking Turn once, when that Turn ends", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const person = await signedInViewer("maya@example.com");
      const childId = await startThread(harness, "task-dismiss-early", {
        kind: "task",
      });
      await askInTask(harness, childId, person, async (itemId) => {
        await actOnInboxItem({
          action: "dismiss",
          delivery: { queue: harness.queue, show: async () => {} },
          id: itemId,
          user: person,
        });
      });

      const texts = (await parentMessages()).map(
        (message) => message.input.text,
      );
      expect(
        texts.filter((text) => text.includes('status="completed"')),
      ).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("keeps the parent of an asking child from reporting completed while the answer is open", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const person = await signedInViewer("maya@example.com");
      const childId = await startThread(harness, "task-parent", {
        kind: "task",
      });
      const grandchildId = await startThread(harness, "task-grandchild", {
        kind: "task",
        parentConversationId: childId,
      });

      await askInTask(harness, grandchildId, person);
      // The `waiting` update waits out its batch window.
      vi.setSystemTime(Date.now() + 60_000);
      // The child takes its task and the grandchild's `waiting` update, and
      // ends each Turn with `noReply`.
      harness.onRun(async (run) => await finishRun(run, { noReply: {} }));
      await harness.drain(childId);
      harness.onRun(undefined);

      // The grandchild still waits on the person, so the root gets no
      // completed result from the child.
      expect(await parentMessages()).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
