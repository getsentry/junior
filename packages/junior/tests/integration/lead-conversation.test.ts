import { createWebSource } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import {
  getAgentInvocationId,
  getUnnamedAgentConversationId,
} from "@/chat/agent-invocations/ids";
import { bindMessageAgent } from "@/chat/agent-invocations/message";
import { readRootConversation } from "@/chat/agent-invocations/root-conversation";
import type { AgentRun } from "@/chat/agent/types";
import {
  createAndEnqueueConversation,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import { markConversationsStopped } from "@/chat/conversations/session-stop";
import { stopConversation } from "@/chat/conversations/stop";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import {
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { getLeadConversation } from "@/chat/lead/conversation";
import { createStartConversationTool } from "@/chat/tools/start-conversation";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createMessageAgentTool } from "@/chat/tools/runtime/message-agent";
import { createSearchConversationsTool } from "@/chat/tools/search-conversations";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { createWatchEventsTool } from "@/chat/tools/watch-events";
import { createAddReviewItemTool } from "@/chat/tools/review-items";
import { createSlackReviewItemToolServices } from "@/chat/slack/review-item-tools";
import { publishConversationStatus } from "@/chat/conversations/watch-events";
import {
  juniorConversationParticipants,
  juniorConversations,
  juniorDestinations,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { getConversationWorkState } from "@/chat/task-execution/store";
import {
  createConversationWorkHarness,
  createConversationWorkQueueTestAdapter,
} from "../fixtures/conversation-work";
import { signedInViewer } from "../fixtures/user";

/**
 * Integration tests do not run the agent. This runner reads each run and
 * stops it.
 */
function readRunsAgentRunner() {
  const runs: AgentRun[] = [];
  return {
    agentRunner: {
      run: async (run: AgentRun): Promise<never> => {
        runs.push(run);
        throw new Error("stop after reading the run");
      },
    },
    runs,
  };
}

const LEAD_TASK = "Unpublish abc.png from the public image host.";

describe("Lead", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("keeps one private Lead for each person", async () => {
    const ana = await signedInViewer("lead-ana@example.com");
    const bo = await signedInViewer("lead-bo@example.com");

    // Two first requests at once still make one Lead.
    const [first, second] = await Promise.all([
      getLeadConversation(ana),
      getLeadConversation(ana),
    ]);

    expect(second.conversationId).toBe(first.conversationId);
    expect(first).toMatchObject({ kind: "lead", visibility: "private" });
    expect((await getLeadConversation(ana)).conversationId).toBe(
      first.conversationId,
    );
    expect((await getLeadConversation(bo)).conversationId).not.toBe(
      first.conversationId,
    );
  });

  it("starts a public root that runs the Lead's task as the person", async () => {
    const runner = readRunsAgentRunner();
    const harness = await createConversationWorkHarness(runner.agentRunner);
    const ana = await signedInViewer("lead-start@example.com");
    const lead = await getLeadConversation(ana);
    const start = (toolCallId: string) =>
      createStartConversationTool({
        conversationId: lead.conversationId,
        conversationWorkQueue: harness.queue,
        turnId: "lead-turn",
      }).execute!({ task: LEAD_TASK, title: "Image cleanup" }, { toolCallId });

    const { conversation_id: started } = (await start("call-1")) as {
      conversation_id: string;
    };
    // A replay of the tool call starts nothing new.
    await expect(start("call-1")).resolves.toMatchObject({
      conversation_id: started,
    });

    expect(
      await getConversationStore().get({ conversationId: started }),
    ).toMatchObject({
      kind: "root",
      title: "Image cleanup",
      visibility: "public",
    });
    // The person is the root Actor, so they take part in the new root.
    expect(
      await getDb()
        .select({ userId: juniorConversationParticipants.userId })
        .from(juniorConversationParticipants)
        .where(eq(juniorConversationParticipants.rootConversationId, started)),
    ).toEqual([{ userId: ana.id }]);

    await harness.process(harness.queue.takeMessageFor(started));
    const [run] = runner.runs;
    // The Turn runs as the person, with the Lead's task as their request.
    expect(run!.actor).toMatchObject({ platform: "web", userId: ana.id });
    expect(run!.instruction.inputs).toEqual([
      { kind: "person", text: LEAD_TASK },
    ]);
    const root = await readRootConversation({
      actor: webActorFromUser(ana),
      conversationId: started,
    });
    expect(root.messages).toEqual([{ author: "user", text: LEAD_TASK }]);
  });

  it("finds and steers only the public roots that its person takes part in", async () => {
    const runner = readRunsAgentRunner();
    const { queue, state } = await createConversationWorkHarness(
      runner.agentRunner,
    );
    const ana = await signedInViewer("lead-steer@example.com");
    const bo = await signedInViewer("lead-other@example.com");
    const lead = await getLeadConversation(ana);
    const anaWork = await createAndEnqueueConversation(
      {
        actor: webActorFromUser(ana),
        idempotencyKey: "lead-steer-ana",
        message: "Check the deploy.",
      },
      { queue, state },
    );
    const boWork = await createAndEnqueueConversation(
      {
        actor: webActorFromUser(bo),
        idempotencyKey: "lead-steer-bo",
        message: "Check the other deploy.",
      },
      { queue, state },
    );

    const found = (await createSearchConversationsTool({
      conversationId: lead.conversationId,
      resolveUserId: async () => ana.id,
    }).execute!({ participating: true }, { toolCallId: "call-search" })) as {
      conversations: { conversation_id: string }[];
    };
    expect(found.conversations.map((match) => match.conversation_id)).toEqual([
      anaWork.conversationId,
    ]);

    const leadRun: AgentRun = {
      actor: webActorFromUser(ana),
      conversationId: lead.conversationId,
      destination: lead.destination!,
      instruction: { text: "Tell my deploy check to hurry." },
      source: createWebSource(lead.conversationId, "private"),
      turnId: "lead-steer-turn",
    };
    const send = async (to: string, toolCallId: string) =>
      await createMessageAgentTool(bindMessageAgent(leadRun, { queue, state })!)
        .execute!({ text: "Please hurry.", to }, { toolCallId });

    await expect(send(anaWork.conversationId, "call-ana")).resolves.toEqual({
      conversation_id: anaWork.conversationId,
      delivery: "queued",
    });
    await expect(send(boWork.conversationId, "call-bo")).rejects.toThrow(
      "is a public conversation and this conversation is private",
    );
  });

  it("watches only the Conversations that it may read", async () => {
    const runner = readRunsAgentRunner();
    const harness = await createConversationWorkHarness(runner.agentRunner);
    const ana = await signedInViewer("lead-watch@example.com");
    const bo = await signedInViewer("lead-watch-other@example.com");
    const lead = await getLeadConversation(ana);
    const boLead = await getLeadConversation(bo);
    const boWork = await createAndEnqueueConversation(
      {
        actor: webActorFromUser(bo),
        idempotencyKey: "lead-watch-bo",
        message: "Check the other deploy.",
      },
      { queue: harness.queue, state: harness.state },
    );
    const started = (await createStartConversationTool({
      conversationId: lead.conversationId,
      conversationWorkQueue: harness.queue,
      turnId: "lead-watch-turn",
    }).execute!(
      { task: "Check the deploy.", title: "Deploy check" },
      { toolCallId: "call-start" },
    )) as {
      conversation_id: string;
      subscribable: { identifier: string; namespace: string; type: string };
    };
    // startConversation offers the Watch. It does not make one.
    expect(started.subscribable).toMatchObject({
      identifier: started.conversation_id,
      namespace: "junior",
      type: "conversation",
    });

    const watch = (watcher: string, identifier: string) =>
      createWatchEventsTool(
        { conversationId: watcher } as ToolRuntimeContext,
        getEventCatalog(),
      ).execute!(
        {
          events: [
            "conversation.completed",
            "conversation.failed",
            "conversation.waiting",
            "conversation.stopped",
          ],
          identifier,
          intent: "Tell the person when the deploy check is done.",
          label: "Deploy check",
          namespace: "junior",
          resource_type: "conversation",
        },
        { toolCallId: `call-watch-${watcher}-${identifier}` },
      );
    // The same tree, and a public root, are readable.
    await expect(
      watch(lead.conversationId, lead.conversationId),
    ).resolves.toMatchObject({ subscription_status: "active" });
    await watch(lead.conversationId, started.conversation_id);
    await watch(boWork.conversationId, started.conversation_id);
    // Any kind may be watched, so a child agent of that root is too.
    const child = getUnnamedAgentConversationId(
      getAgentInvocationId(started.conversation_id, "lead-watch-child"),
    );
    await getConversationStore().createChild({
      childConversationId: child,
      kind: "task",
      parentConversationId: started.conversation_id,
      source: "internal",
    });
    await watch(lead.conversationId, child);
    await watch(boWork.conversationId, child);
    // A private Conversation in another tree and Destination is not. A
    // missing Conversation gets the same error.
    for (const [watcher, target] of [
      [lead.conversationId, boLead.conversationId],
      [boWork.conversationId, lead.conversationId],
      [lead.conversationId, "local:web:missing"],
    ] as const) {
      await expect(watch(watcher, target)).rejects.toThrow(
        `Conversation is not accessible: ${target}`,
      );
    }

    const lifecycle = new ConversationTurnLifecycleService(
      getConversationEventStore(),
      { watchQueue: () => harness.queue },
    );
    const endTurn = async (turnId: string, inputMessageIds: string[]) => {
      await lifecycle.start({
        conversationId: started.conversation_id,
        createdAtMs: Date.now(),
        inputMessageIds,
        surface: "internal",
        turnId,
      });
      await lifecycle.complete({
        conversationId: started.conversation_id,
        createdAtMs: Date.now(),
        outcome: "success",
        turnId,
      });
    };
    const heard = async (conversationId: string) =>
      (
        await getConversationWorkState({ conversationId, state: harness.state })
      )?.messages.map((message) => message.input.text) ?? [];

    // No status Event ends the Watch, so the watchers hear each one. A Turn
    // that only the root's own Watch Events started reports nothing.
    await endTurn("root-turn-1", ["person-message-1"]);
    await endTurn("root-turn-2", ["event:resub_1:github:pr:1"]);
    await lifecycle.fail({
      conversationId: started.conversation_id,
      createdAtMs: Date.now(),
      failureCode: "agent_run_failed",
      turnId: "root-turn-3",
    });
    // A worker that loses the race to end a Turn reports the stored end,
    // not its own.
    await getConversationEventStore().append(started.conversation_id, [
      {
        idempotencyKey: "turn:root-turn-5:terminal",
        createdAtMs: Date.now(),
        data: {
          type: "turn_completed",
          turnId: "root-turn-5",
          outcome: "success",
        },
      },
    ]);
    await lifecycle.fail({
      conversationId: started.conversation_id,
      createdAtMs: Date.now(),
      failureCode: "agent_run_failed",
      turnId: "root-turn-5",
    });
    // A child agent's status reaches the Watches on that child.
    await publishConversationStatus(
      child,
      { type: "waiting", reviewItemId: "lead-watch-item" },
      { queue: harness.queue, state: harness.state },
    );
    // An update that makes a notice an action reports a wait.
    const addItem = createAddReviewItemTool(
      {
        conversationId: started.conversation_id,
        conversationWorkQueue: harness.queue,
        resolveActorIdentity: async () => undefined,
        source: { kind: "scheduled_automation" },
      },
      createSlackReviewItemToolServices(createConversationWorkQueueTestAdapter),
    ) as any;
    const item = {
      assignees: ["everyone"],
      body: "Check the deploy.",
      dedupe_key: "deploy-check",
      title: "Deploy check",
    };
    const request = {
      question: "Ship it?",
      fields: [
        {
          id: "ship",
          kind: "choice",
          label: "Ship",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    };
    for (const input of [
      { ...item, kind: "notice" },
      { ...item, kind: "action", request },
    ]) {
      await addItem.execute(addItem.prepareArguments(input), {});
    }
    await stopConversation({
      conversationId: started.conversation_id,
      queue: harness.queue,
      state: harness.state,
    });
    // A later retry of the stop does not report it again.
    await markConversationsStopped([started.conversation_id], {
      cancelWatches: false,
      nowMs: Date.now() + 1_000,
      queue: harness.queue,
      state: harness.state,
    });
    const statuses = [
      expect.stringContaining("conversation.completed"),
      expect.stringContaining("conversation.failed"),
      expect.stringContaining("conversation.completed"),
      expect.stringContaining("conversation.waiting"),
      expect.stringContaining("conversation.waiting"),
      expect.stringContaining("conversation.stopped"),
    ];
    expect(await heard(lead.conversationId)).toEqual(statuses);
    expect(await heard(boWork.conversationId)).toEqual([
      expect.stringContaining("Check the other deploy."),
      ...statuses,
    ]);

    // Delivery checks access again and fails closed: once the root is
    // private, no other tree hears it.
    const [root] = await getDb()
      .select({ destinationId: juniorConversations.destinationId })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, started.conversation_id));
    await getDb()
      .update(juniorDestinations)
      .set({ visibility: "private" })
      .where(eq(juniorDestinations.id, root!.destinationId!));
    await endTurn("root-turn-4", ["person-message-4"]);
    expect(await heard(lead.conversationId)).toEqual(statuses);
    expect(await heard(boWork.conversationId)).toHaveLength(7);
  });
});
