import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDeliverToParent,
  enqueueChildResultToParent,
} from "@/chat/agent-invocations/result";
import { readInboundMessageSender } from "@/chat/task-execution/message-sender";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
import {
  slackInvocationInput,
  slackParentConversationId,
} from "../fixtures/agent-invocations";
import { spawnChildWithoutAgentInvocation } from "../fixtures/child-without-agent-invocation";
import {
  createHarness,
  finishRun,
  type Harness,
} from "../fixtures/thread-input";

const actor = slackInvocationInput.actor;

/** Spawn a child agent of `parentConversationId` as `spawnAgent` does. */
async function spawn(
  harness: Harness,
  idempotencyKey: string,
  parentConversationId = slackParentConversationId,
) {
  return await spawnChildWithoutAgentInvocation({
    actor,
    conversationStore: harness.conversationStore,
    idempotencyKey,
    parentConversationId,
    queue: harness.queue,
    state: harness.state,
  });
}

/** Run the child's queued task to its end without a `reply`. */
async function finishTask(harness: Harness, conversationId: string) {
  harness.onRun(finishRun);
  await harness.drain(conversationId);
  harness.onRun(undefined);
}

async function lastMessage(conversationId: string) {
  return (await getConversationWorkState({ conversationId }))?.messages.at(-1);
}

describe("nested child agents", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
  });

  it("sends each nested child's reply up to its parent as the Actor that started the tree", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    const deliver = createDeliverToParent({
      queue: harness.queue,
      state: harness.state,
    });
    // The child that replies runs the result of its own child first.
    const replyAfterResult = async (
      sender: string,
      text: string,
      parentConversationId: string,
    ) => {
      await deliver({
        actor,
        conversationId: sender,
        result: { kind: "reply", reply: { text, toolCallId: "call-reply" } },
        turnId: `turn_${text}`,
      });
      // The result waits out its batch window.
      vi.setSystemTime(Date.now() + 60_000);
      harness.onRun(finishRun);
      await harness.processUntilRun(parentConversationId);
      harness.onRun(undefined);
      return harness.runs.at(-1)!;
    };
    try {
      const child = await spawn(harness, "nested-child");
      const helper = await spawn(harness, "nested-helper", child);
      const grandHelper = await spawn(harness, "nested-grand-helper", helper);
      for (const conversationId of [child, helper, grandHelper]) {
        await finishTask(harness, conversationId);
      }

      // The result runs on the helper as the Actor that started the tree,
      // with the root Location.
      const helperRun = await replyAfterResult(
        grandHelper,
        "Grand helper fact: 42.",
        helper,
      );
      expect(helperRun).toMatchObject({
        actor,
        conversationId: helper,
        disabledFeatures: ["interactive-auth"],
        location: expect.objectContaining({
          provider: "slack",
          channelId: "C123",
        }),
      });
      expect(helperRun.instruction.text).toContain("Grand helper fact: 42.");

      // Each child reports from the Turn that read the result of its own
      // child.
      const childRun = await replyAfterResult(
        helper,
        "Helper fact: 42.",
        child,
      );
      expect(childRun).toMatchObject({ actor, conversationId: child });
      expect(childRun.instruction.text).toContain("Helper fact: 42.");
      await deliver({
        actor,
        conversationId: child,
        result: {
          kind: "reply",
          reply: { text: "Final answer: 42.", toolCallId: "call-reply" },
        },
        turnId: "turn_final",
      });
      const parentMessages =
        (
          await getConversationWorkState({
            conversationId: slackParentConversationId,
          })
        )?.messages ?? [];
      expect(parentMessages).toHaveLength(1);
      expect(parentMessages[0]!.input.text).toMatch(
        /^<agent-result [^>]*status="completed"/,
      );
      expect(parentMessages[0]!.input.text).toContain("Final answer: 42.");
    } finally {
      await harness.close();
    }
  });

  it("sends a child's reply as a message while its own child agent works", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    const sendReply = async (
      sender: string,
      parentConversationId: string,
      text: string,
    ) =>
      await enqueueChildResultToParent({
        actor,
        result: { kind: "reply", reply: { text, toolCallId: text } },
        messageKey: text,
        queue: harness.queue,
        sender: { childConversationId: sender, parentConversationId },
        turnId: `turn_${sender}`,
        state: harness.state,
      });
    const lastText = async (conversationId: string) =>
      (await lastMessage(conversationId))?.input.text;
    try {
      const child = await spawn(harness, "talking-child");
      const helper = await spawn(harness, "talking-helper", child);

      // A reply while the helper runs is a message: the parent can tell
      // that the child still works.
      await sendReply(child, slackParentConversationId, "Started a helper.");
      expect(await lastText(slackParentConversationId)).toMatch(
        /^<agent-message [^>]*source="child_agent"/,
      );
      const progress = await lastMessage(slackParentConversationId);
      expect(progress && readInboundMessageSender(progress)).toEqual({
        conversationId: child,
        turnId: `turn_${child}`,
      });

      // A helper reply that waits in the child's mailbox starts another
      // child Turn, so the child still works.
      await finishTask(harness, helper);
      await sendReply(helper, child, "CEDAR-9");
      await sendReply(child, slackParentConversationId, "Still waiting.");
      expect(await lastText(slackParentConversationId)).toMatch(
        /^<agent-message /,
      );

      // With no open work left, the reply is the child's result.
      const done = await spawn(harness, "done-child");
      const doneHelper = await spawn(harness, "done-helper", done);
      await finishTask(harness, doneHelper);
      await sendReply(done, slackParentConversationId, "Final answer.");
      expect(await lastText(slackParentConversationId)).toMatch(
        /^<agent-result [^>]*status="completed"/,
      );
    } finally {
      await harness.close();
    }
  });
});
