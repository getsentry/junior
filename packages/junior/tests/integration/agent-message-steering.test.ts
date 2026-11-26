/**
 * `messageAgent` messages that steer a running Turn of the target: a child's
 * messages to its parent and messages between top-level agents.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindMessageAgent } from "@/chat/agent-invocations/message";
import type { AgentRun, AgentSteeringMessage } from "@/chat/agent/types";
import {
  createEventSource,
  createWebSource,
  type Source,
  type User,
} from "@sentry/junior-plugin-api";
import {
  createAndEnqueueConversation,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import { EVENT_WAIT_MS } from "@/chat/events/notification";
import { getConversationStore } from "@/chat/db";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  getConversationWorkState,
  type InboundMessage,
} from "@/chat/task-execution/store";
import { createMessageAgentTool } from "@/chat/tools/runtime/message-agent";
import { credentialContextForActor } from "@/chat/credentials/context";
import { signedInViewer } from "../fixtures/user";
import {
  slackInvocationInput,
  slackParentConversationId,
} from "../fixtures/agent-invocations";
import { spawnChildWithoutAgentInvocation } from "../fixtures/child-without-agent-invocation";
import {
  commitRunInput,
  createHarness,
  finishRun,
  slackParentRun,
  steerRun,
  type Harness,
} from "../fixtures/thread-input";

const parentActor = slackInvocationInput.actor;

/** A Run of one child agent's Turn for a parent message. */
function childRun(conversationId: string): AgentRun {
  return slackParentRun({
    conversationId,
    instruction: { text: "Check the deploy." },
    source: { kind: "parent_message" },
    turnId: `turn_${conversationId}`,
  });
}

/** Spawn a child agent of `parentConversationId` as `startAgent` does. */
async function spawnChild(
  harness: Harness,
  idempotencyKey: string,
  input: Partial<Parameters<typeof spawnChildWithoutAgentInvocation>[0]> = {},
) {
  return await spawnChildWithoutAgentInvocation({
    actor: parentActor,
    conversationStore: harness.conversationStore,
    idempotencyKey,
    parentConversationId: slackParentConversationId,
    queue: harness.queue,
    state: harness.state,
    ...input,
  });
}

/** Read the Event messages, such as agent messages, in one mailbox. */
async function eventMessages(
  conversationId: string,
): Promise<InboundMessage[]> {
  const work = await getConversationWorkState({ conversationId });
  return work?.messages.filter((message) => message.source === "event") ?? [];
}

describe("agent message steering", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
  });

  it("steers a child's messages into the parent's running Turn for the same Actor", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    const { queue, state } = harness;
    const otherActor = {
      platform: "slack",
      teamId: "T123",
      userId: "U999",
    } as const;
    try {
      const childId = await spawnChild(harness, "steer-parent-child", {
        agentName: "researcher",
      });
      // A person's Turn in the child's Thread, unless a Source says
      // otherwise.
      const send = async (
        actor: AgentRun["actor"],
        key: string,
        text: string,
        source: Source = slackParentRun().source,
      ) =>
        await createMessageAgentTool(
          bindMessageAgent(
            {
              ...childRun(childId),
              actor,
              credentialContext: credentialContextForActor(actor!),
              source,
            },
            { queue, state },
          )!,
        ).execute!({ text, to: "parent" }, { toolCallId: key });
      // The first message starts the parent's Turn after the Event window.
      await send(parentActor, "call-first", "Started on the deploy.");
      vi.setSystemTime(Date.now() + EVENT_WAIT_MS + 10);

      const drained: AgentSteeringMessage[][] = [];
      harness.onRun(async (run) => {
        if (harness.runs.length > 1) return await finishRun(run);
        await commitRunInput(run);
        const startedAtMs = Date.now();
        // The child sends these while the parent's model call runs.
        await send(parentActor, "call-retry", "The retry path is fine.");
        vi.setSystemTime(Date.now() + 1);
        await send(parentActor, "call-timeout", "The timeout is fine.");
        // A child Turn that a parent message started acts for no person
        // itself, so its message never steers, even for the same Actor.
        vi.setSystemTime(Date.now() + 1);
        await send(parentActor, "call-logs", "The logs are clean.", {
          kind: "parent_message",
        });
        // A child Turn for another person never steers this Turn.
        vi.setSystemTime(Date.now() + 1);
        await send(otherActor, "call-billing", "Billing looks off.");
        // The fake run saves its prompt with the time that it started at.
        vi.setSystemTime(startedAtMs);
        const steered = await steerRun(run, (messages) => {
          drained.push(messages);
        });
        await steerRun(run, (messages) => drained.push(messages), steered);
        const outcome = await finishRun(
          run,
          { noReply: {} },
          undefined,
          steered,
        );
        // The other message waits out the Event window, then runs.
        vi.setSystemTime(startedAtMs + EVENT_WAIT_MS + 10);
        return outcome;
      });
      await harness.drain(slackParentConversationId);

      // Both messages join the next model call together, as context with
      // the child Turn's Actor.
      expect(drained).toHaveLength(1);
      expect(drained[0]!.map((message) => message.provenance)).toEqual([
        { authority: "context", actor: parentActor },
        { authority: "context", actor: parentActor },
      ]);
      expect(drained[0]!.map((message) => message.text)).toEqual([
        expect.stringMatching(
          /source="child_agent"[\s\S]*The retry path is fine\./,
        ),
        expect.stringMatching(
          /source="child_agent"[\s\S]*The timeout is fine\./,
        ),
      ]);
      // The other two each run in their own Turn.
      expect(harness.runs.map((run) => run.actor)).toEqual([
        parentActor,
        parentActor,
        otherActor,
      ]);
      expect(harness.runs[1]!.instruction.text).toContain(
        "The logs are clean.",
      );
      expect(harness.runs[2]!.instruction.text).toContain("Billing looks off.");
      expect(await eventMessages(slackParentConversationId)).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("steers a top-level agent's messages into a running root for the same Actor", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    const { queue, state } = harness;
    try {
      const ana = await signedInViewer("top-level-steer@example.com");
      const bo = await signedInViewer("top-level-steer-other@example.com");
      const root = async (person: User, key: string) =>
        (
          await createAndEnqueueConversation(
            {
              actor: webActorFromUser(person),
              idempotencyKey: key,
              message: "Check the deploy.",
            },
            { queue, state },
          )
        ).conversationId;
      const target = await root(ana, "top-level-steer-target");
      const anaSender = await root(ana, "top-level-steer-ana");
      const boSender = await root(bo, "top-level-steer-bo");
      // A Turn of a public root outside any Space. A person started it
      // unless a Source says otherwise.
      const send = async (
        person: User,
        sender: string,
        key: string,
        text: string,
        source: Source = createWebSource(sender, "public"),
      ) =>
        await createMessageAgentTool(
          bindMessageAgent(
            {
              actor: webActorFromUser(person),
              conversationId: sender,
              credentialContext: credentialContextForActor(
                webActorFromUser(person),
              ),
              destination: (await getConversationStore().get({
                conversationId: sender,
              }))!.destination!,
              instruction: { text: "Steer the deploy check." },
              source,
              turnId: `turn-${key}`,
            },
            { queue, state },
          )!,
        ).execute!({ text, to: target }, { toolCallId: key });

      const drained: AgentSteeringMessage[][] = [];
      harness.onRun(async (run) => {
        if (harness.runs.length > 1) return await finishRun(run);
        await commitRunInput(run);
        const startedAtMs = Date.now();
        await expect(
          send(ana, anaSender, "call-retry", "Also check the retry path."),
        ).resolves.toEqual({ conversation_id: target, delivery: "queued" });
        vi.setSystemTime(Date.now() + 1);
        await send(ana, anaSender, "call-timeout", "Also check the timeout.");
        vi.setSystemTime(Date.now() + 1);
        // A Watch Turn acts for no person, so its message never steers,
        // even with ana's Actor and credentials.
        await send(
          ana,
          anaSender,
          "call-watch",
          "Check the alerts.",
          createEventSource({
            eventKey: "pr-merged",
            eventType: "pull_request.merged",
            identifier: "getsentry/junior#1",
            namespace: "github",
          }),
        );
        vi.setSystemTime(Date.now() + 1);
        await send(bo, boSender, "call-billing", "Check billing.");
        vi.setSystemTime(startedAtMs);
        const steered = await steerRun(run, (messages) => {
          drained.push(messages);
        });
        const outcome = await finishRun(
          run,
          { noReply: {} },
          undefined,
          steered,
        );
        vi.setSystemTime(startedAtMs + EVENT_WAIT_MS + 10);
        return outcome;
      });
      await harness.drain(target);

      // Both of ana's messages join together, as data.
      expect(drained).toHaveLength(1);
      expect(drained[0]!.map((message) => message.provenance)).toEqual([
        { authority: "context" },
        { authority: "context" },
      ]);
      expect(drained[0]!.map((message) => message.text)).toEqual([
        expect.stringMatching(
          /source="top_level_agent"[\s\S]*Also check the retry path\./,
        ),
        expect.stringMatching(
          /source="top_level_agent"[\s\S]*Also check the timeout\./,
        ),
      ]);
      // The Watch Turn's message stops the scan. It and bo's message each
      // run in their own Turn, as the event system Actor.
      expect(harness.runs.map((run) => run.actor)).toEqual([
        expect.objectContaining({ platform: "web", userId: ana.id }),
        EVENT_SYSTEM_ACTOR,
        EVENT_SYSTEM_ACTOR,
      ]);
      expect(harness.runs[1]!.instruction.text).toContain("Check the alerts.");
      expect(harness.runs[2]!.instruction.text).toContain("Check billing.");
    } finally {
      await harness.close();
    }
  });

  it("does not steer a message from a Turn of the same Actor with other credentials", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    const { queue, state } = harness;
    try {
      const ana = await signedInViewer("other-credentials@example.com");
      const anaActor = webActorFromUser(ana);
      const root = async (key: string) =>
        (
          await createAndEnqueueConversation(
            {
              actor: anaActor,
              idempotencyKey: key,
              message: "Check the deploy.",
            },
            { queue, state },
          )
        ).conversationId;
      const target = await root("other-credentials-target");
      const sender = await root("other-credentials-sender");
      // A Turn for ana's Actor whose credentials are not ana's own, so its
      // credential digest differs from the running Turn's.
      const bo = await signedInViewer("other-credentials-bo@example.com");
      const credentialContext = credentialContextForActor(webActorFromUser(bo));
      const drained: AgentSteeringMessage[][] = [];
      harness.onRun(async (run) => {
        if (harness.runs.length > 1) return await finishRun(run);
        await commitRunInput(run);
        const startedAtMs = Date.now();
        await createMessageAgentTool(
          bindMessageAgent(
            {
              actor: anaActor,
              conversationId: sender,
              credentialContext,
              destination: (await getConversationStore().get({
                conversationId: sender,
              }))!.destination!,
              instruction: { text: "Steer the deploy check." },
              source: createWebSource(sender, "public"),
              turnId: "other-credentials-turn",
            },
            { queue, state },
          )!,
        ).execute!(
          { text: "Also check the retry path.", to: target },
          { toolCallId: "call-other-credentials" },
        );
        vi.setSystemTime(startedAtMs);
        const steered = await steerRun(run, (messages) => {
          drained.push(messages);
        });
        const outcome = await finishRun(
          run,
          { noReply: {} },
          undefined,
          steered,
        );
        vi.setSystemTime(startedAtMs + EVENT_WAIT_MS + 10);
        return outcome;
      });
      await harness.drain(target);

      // The message waits and runs in its own Turn.
      expect(drained.flat()).toEqual([]);
      expect(harness.runs.map((run) => run.actor)).toEqual([
        expect.objectContaining({ platform: "web", userId: ana.id }),
        EVENT_SYSTEM_ACTOR,
      ]);
      expect(harness.runs[1]!.instruction.text).toContain(
        "Also check the retry path.",
      );
    } finally {
      await harness.close();
    }
  });

  it("never adds an agent message to a person's input when a Turn starts", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    const { queue, state } = harness;
    try {
      const ana = await signedInViewer("turn-start-agent-message@example.com");
      const root = async (key: string) =>
        (
          await createAndEnqueueConversation(
            {
              actor: webActorFromUser(ana),
              idempotencyKey: key,
              message: "Check the deploy.",
            },
            { queue, state },
          )
        ).conversationId;
      const target = await root("turn-start-target");
      const sender = await root("turn-start-sender");
      // ana's own Turn sends it before the target's first Turn starts.
      await createMessageAgentTool(
        bindMessageAgent(
          {
            actor: webActorFromUser(ana),
            conversationId: sender,
            credentialContext: credentialContextForActor(webActorFromUser(ana)),
            destination: (await getConversationStore().get({
              conversationId: sender,
            }))!.destination!,
            instruction: { text: "Steer the deploy check." },
            source: createWebSource(sender, "public"),
            turnId: "turn-start-sender-turn",
          },
          { queue, state },
        )!,
      ).execute!(
        { text: "Also check the retry path.", to: target },
        { toolCallId: "call-turn-start" },
      );
      harness.onRun(async (run) => {
        const outcome = await finishRun(run);
        vi.setSystemTime(Date.now() + EVENT_WAIT_MS + 10);
        return outcome;
      });
      await harness.drain(target);

      // The person's Turn starts with the person's input only. The agent
      // message runs in its own Turn with a non-person Source.
      expect(harness.runs.map((run) => run.actor)).toEqual([
        expect.objectContaining({ platform: "web", userId: ana.id }),
        EVENT_SYSTEM_ACTOR,
      ]);
      expect(harness.runs[0]!.instruction.text).not.toContain(
        "Also check the retry path.",
      );
      expect(harness.runs[1]!.source.kind).toBe("event");
      expect(harness.runs[1]!.instruction.text).toContain(
        "Also check the retry path.",
      );
    } finally {
      await harness.close();
    }
  });
});
