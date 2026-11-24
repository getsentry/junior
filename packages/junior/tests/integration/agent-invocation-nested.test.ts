import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueChildResultToParent } from "@/chat/agent-invocations/result";
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

/** Spawn a child agent of `parentConversationId` as `startAgent` does. */
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

/** Run the child's queued task to its end with no final text. */
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
    // The child that replies runs the result of its own child first.
    const replyAfterResult = async (conversationId: string, text: string) => {
      // The result waits out its batch window.
      vi.setSystemTime(Date.now() + 60_000);
      harness.onRun(async (run) => await finishRun(run, { finalText: text }));
      await harness.processUntilRun(conversationId);
      harness.onRun(undefined);
      return harness.runs.at(-1)!;
    };
    try {
      const child = await spawn(harness, "nested-child");
      const helper = await spawn(harness, "nested-helper", child);
      const grandHelper = await spawn(harness, "nested-grand-helper", helper);
      // Each child's own child agent still works, so these Turns end with no
      // result.
      for (const conversationId of [child, helper]) {
        await finishTask(harness, conversationId);
      }
      harness.onRun(
        async (run) =>
          await finishRun(run, { finalText: "Grand helper fact: 42." }),
      );
      await harness.drain(grandHelper);

      // The result runs on the helper as the Actor that started the tree,
      // with the root Location.
      const helperRun = await replyAfterResult(helper, "Helper fact: 42.");
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
      const childRun = await replyAfterResult(child, "Final answer: 42.");
      expect(childRun).toMatchObject({ actor, conversationId: child });
      expect(childRun.instruction.text).toContain("Helper fact: 42.");
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
        result: { kind: "completed", text },
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

      // With no open work left, the reply is the child's result. The
      // helper's result runs on the child first.
      const done = await spawn(harness, "done-child");
      const doneHelper = await spawn(harness, "done-helper", done);
      await finishTask(harness, doneHelper);
      vi.setSystemTime(Date.now() + 60_000);
      await finishTask(harness, done);
      await sendReply(done, slackParentConversationId, "Final answer.");
      expect(await lastText(slackParentConversationId)).toMatch(
        /^<agent-result [^>]*status="completed"/,
      );
    } finally {
      await harness.close();
    }
  });

  it("reports a Task whose helper ended its work with noReply", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    const endWith = async (
      conversationId: string,
      answer: Parameters<typeof finishRun>[1],
    ) => {
      harness.onRun(async (run) => await finishRun(run, answer));
      await harness.drain(conversationId);
      harness.onRun(undefined);
    };
    const texts = async (conversationId: string) =>
      (await getConversationWorkState({ conversationId }))?.messages.map(
        (message) => message.input.text,
      );
    try {
      const child = await spawn(harness, "quiet-child");
      const helper = await spawn(harness, "quiet-helper", child);
      // The child replies while its helper works, so the parent reads a
      // message, not the child's result.
      await endWith(child, { finalText: "Partial findings." });
      await endWith(helper, { noReply: { note: "Helper found nothing." } });
      await expect(texts(child)).resolves.toEqual([
        expect.stringMatching(
          /^<agent-result [^>]*status="completed">\n[\s\S]*\nHelper found nothing\.\n/,
        ),
      ]);

      // The helper's result waits out its batch window.
      vi.setSystemTime(Date.now() + 60_000);
      await endWith(child, { noReply: { note: "The findings stand." } });
      await expect(texts(slackParentConversationId)).resolves.toEqual([
        expect.stringMatching(
          /^<agent-message [^>]*>\n[\s\S]*\nPartial findings\.\n/,
        ),
        expect.stringMatching(
          /^<agent-result [^>]*status="completed">\n[\s\S]*\nThe findings stand\.\n/,
        ),
      ]);
    } finally {
      await harness.close();
    }
  });
});
