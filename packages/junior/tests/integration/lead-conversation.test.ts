import { createWebSource } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { bindMessageAgent } from "@/chat/agent-invocations/message";
import { readRootConversation } from "@/chat/agent-invocations/root-conversation";
import type { AgentRun } from "@/chat/agent/types";
import {
  createAndEnqueueConversation,
  webActorFromUser,
} from "@/chat/conversations/web-input";
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
import { juniorConversationParticipants } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { createConversationWorkHarness } from "../fixtures/conversation-work";
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

  it("watches the Conversations that it may read and hears every status", async () => {
    const runner = readRunsAgentRunner();
    const harness = await createConversationWorkHarness(runner.agentRunner);
    const ana = await signedInViewer("lead-watch@example.com");
    const bo = await signedInViewer("lead-watch-other@example.com");
    const lead = await getLeadConversation(ana);
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
    expect(started.subscribable).toMatchObject({
      identifier: started.conversation_id,
      namespace: "junior",
      type: "conversation",
    });
    // Drop the start of the new root, so only Watch Events stay queued.
    harness.queue.takeMessageFor(started.conversation_id);

    const watch = (identifier: string) =>
      createWatchEventsTool(
        { conversationId: lead.conversationId } as ToolRuntimeContext,
        getEventCatalog(),
      ).execute!(
        {
          events: [
            "conversation.turn.completed",
            "conversation.turn.failed",
            "conversation.stopped",
          ],
          identifier,
          intent: "Tell the person when the deploy check is done.",
          label: "Deploy check",
          namespace: started.subscribable.namespace,
          resource_type: started.subscribable.type,
        },
        { toolCallId: `call-watch-${identifier}` },
      );
    await watch(started.subscribable.identifier);
    // Another person's private Lead is not readable, so it is not watchable.
    const boLead = await getLeadConversation(bo);
    await expect(watch(boLead.conversationId)).rejects.toThrow(
      `Conversation events are not accessible: ${boLead.conversationId}`,
    );

    const lifecycle = new ConversationTurnLifecycleService(
      getConversationEventStore(),
      { watchQueue: () => harness.queue },
    );
    // No status Event ends the Watch, so the Lead hears each one.
    await lifecycle.complete({
      conversationId: started.conversation_id,
      createdAtMs: Date.now(),
      outcome: "success",
      turnId: "root-turn-1",
    });
    await lifecycle.fail({
      conversationId: started.conversation_id,
      createdAtMs: Date.now(),
      failureCode: "agent_run_failed",
      turnId: "root-turn-2",
    });
    await stopConversation({
      conversationId: started.conversation_id,
      queue: harness.queue,
      state: harness.state,
    });

    const work = await getConversationWorkState({
      conversationId: lead.conversationId,
      state: harness.state,
    });
    expect(work?.messages.map((message) => message.input.text)).toEqual([
      expect.stringContaining("conversation.turn.completed"),
      expect.stringContaining("conversation.turn.failed"),
      expect.stringContaining("conversation.stopped"),
    ]);
  });
});
