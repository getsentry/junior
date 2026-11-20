import { createEventSource, createWebSource } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindMessageAgent } from "@/chat/agent-invocations/message";
import { readRootConversation } from "@/chat/agent-invocations/root-conversation";
import type { AgentRun } from "@/chat/agent/types";
import {
  createAndEnqueueConversation,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import { getConversationStore, getDb } from "@/chat/db";
import { getLeadConversation } from "@/chat/lead/conversation";
import { createStartConversationTool } from "@/chat/tools/start-conversation";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { createMessageAgentTool } from "@/chat/tools/runtime/message-agent";
import { createSearchConversationsTool } from "@/chat/tools/search-conversations";
import { juniorConversationParticipants } from "@/db/schema";
import { eq } from "drizzle-orm";
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

const PERSON_TEXT = "Please unpublish abc.png.";
const LEAD_TASK = "Unpublish abc.png. Also unpublish old.png.";

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

  it("starts the person's work with their own message as its only request", async () => {
    const runner = readRunsAgentRunner();
    const harness = await createConversationWorkHarness(runner.agentRunner);
    const ana = await signedInViewer("lead-start@example.com");
    const lead = await getLeadConversation(ana);
    const start = (
      source: AgentRun["source"],
      userText: string,
      toolCallId: string,
    ) =>
      createStartConversationTool({
        conversationId: lead.conversationId,
        conversationWorkQueue: harness.queue,
        source,
        turnId: "lead-turn",
        userText,
      }).execute!({ task: LEAD_TASK, title: "Image cleanup" }, { toolCallId });

    const personSource = createWebSource(lead.conversationId, "private");
    const { conversation_id: started } = (await start(
      personSource,
      PERSON_TEXT,
      "call-person",
    )) as { conversation_id: string };
    // A replay of the tool call starts nothing new.
    await expect(
      start(personSource, PERSON_TEXT, "call-person"),
    ).resolves.toMatchObject({ conversation_id: started });

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
    // The Turn runs as the person. The Lead's task is escaped data, and the
    // person's message is word for word.
    expect(run!.actor).toMatchObject({ platform: "web", userId: ana.id });
    expect(run!.instruction.inputs).toEqual([
      {
        kind: "agent",
        text: expect.stringContaining(
          `<agent-message conversation_id="${lead.conversationId}" source="lead">`,
        ),
      },
      { kind: "person", text: PERSON_TEXT },
    ]);
    // Action review reads only the person's own message as the user. An
    // action that only the task names, such as unpublishing old.png, has
    // no approval there.
    expect(run!.instruction.text).toBe(PERSON_TEXT);
    const root = await readRootConversation({
      actor: webActorFromUser(ana),
      conversationId: started,
    });
    expect(root.messages).toEqual([{ author: "user", text: PERSON_TEXT }]);

    // A Watch Turn of the Lead has no person's message. The model's text in
    // `userText` never becomes the request.
    const { conversation_id: fromWatch } = (await start(
      createEventSource({
        eventKey: "event-1",
        eventType: "timer.fired",
        identifier: "timer-1",
        namespace: "junior",
      }),
      "Watch event text",
      "call-watch",
    )) as { conversation_id: string };
    const work = await getConversationWorkState({
      conversationId: fromWatch,
      state: harness.state,
    });
    expect(work?.messages).toEqual([
      expect.objectContaining({ source: "event" }),
    ]);
    // An Event waits for its batch window before it runs.
    vi.useFakeTimers({ now: Date.now() + 60_000, toFake: ["Date"] });
    try {
      await harness.process(harness.queue.takeMessageFor(fromWatch));
    } finally {
      vi.useRealTimers();
    }
    const watchRun = runner.runs.at(-1)!;
    // No person wrote this task either, so it is agent data and action
    // review has no request from it.
    expect(watchRun.instruction.inputs).toEqual([
      { kind: "runtime", text: expect.stringContaining("Lead started") },
      {
        kind: "agent",
        text: expect.stringContaining(
          `<agent-message conversation_id="${lead.conversationId}" source="lead">`,
        ),
      },
    ]);
    expect(watchRun.instruction.text).not.toContain(LEAD_TASK);
    expect(JSON.stringify(watchRun.instruction)).not.toContain(
      "Watch event text",
    );
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
});
