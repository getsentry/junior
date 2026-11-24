import type { Identity, User } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resultAuthorId } from "@/chat/agent-invocations/result-actors";
import type { AgentRun } from "@/chat/agent/types";
import { webActorFromUser } from "@/chat/conversations/web-input";
import { getConversationEventStore } from "@/chat/db";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { actOnInboxItem } from "@/chat/inbox-items/actions";
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
});
