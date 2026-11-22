/** Shared parent Conversation setup for agent invocation integration tests. */
import type { StateAdapter } from "chat";
import { expect } from "vitest";
import {
  createSlackSource,
  defineJuniorPlugin,
  definePluginTool,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { defineJuniorPlugins } from "@/app";
import { spawnChildAgent as spawnChild } from "@/chat/agent-invocations/create";
import { listChildAgents } from "@/chat/agent-invocations/list";
import { commitMessages } from "@/chat/conversations/projection";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import type { ConversationStore } from "@/chat/conversations/store";
import { getConversationEventStore } from "@/chat/db";
import {
  getConversationWorkState,
  hasConversationStop,
  startConversationWork,
} from "@/chat/task-execution/store";
import type { AgentRun } from "@/chat/agent/types";
import type { PiMessage } from "@/chat/pi/messages";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import {
  deferred,
  type ConversationWorkQueueTestAdapter,
} from "./conversation-work";
import { createConfiguredJuniorSqlFixture } from "./sql";
export const parentConversationId = "local:test:parent-agent";
export const destination = {
  conversationId: parentConversationId,
  platform: "local",
} as const;
export const invocationInput = {
  actor: { name: "parent-agent", platform: "system" } as const,
  input: "Summarize the durable task.",
  parentConversationId,
  reasoningLevel: "medium" as const,
};
export const slackParentConversationId = "slack:C123:1712345.0001";
export const slackDestination = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const;
const slackSource = createSlackSource({
  channelId: "C123",
  teamId: "T123",
  threadTs: "1712345.0001",
  visibility: "public",
});
export const slackInvocationInput = {
  ...invocationInput,
  actor: {
    platform: "slack",
    teamId: "T123",
    userId: "U123",
  } as const,
  parentConversationId: slackParentConversationId,
};

export async function prepareParentConversation() {
  const fixture = createConfiguredJuniorSqlFixture();
  await migrateSchema(fixture.sql);
  const conversationStore = createSqlStore(fixture.sql);
  await conversationStore.recordActivity({
    conversationId: parentConversationId,
    destination,
    nowMs: 1_000,
    source: "local",
  });
  return { conversationStore, fixture };
}

export async function prepareSlackParentConversation() {
  const fixture = createConfiguredJuniorSqlFixture();
  await migrateSchema(fixture.sql);
  const conversationStore = createSqlStore(fixture.sql);
  await conversationStore.recordActivity({
    conversationId: slackParentConversationId,
    destination: slackDestination,
    nowMs: 1_000,
    sessionSource: slackSource,
    source: "slack",
    visibility: "public",
  });
  return { conversationStore, fixture };
}

export async function loadTurnEvents(conversationId: string) {
  return (await getConversationEventStore().loadHistory(conversationId)).filter(
    (event) =>
      event.data.type === "turn_started" ||
      event.data.type === "turn_completed" ||
      event.data.type === "turn_failed",
  );
}

export async function loadSubagentEvents(conversationId: string) {
  return (await getConversationEventStore().loadHistory(conversationId))
    .map((event) => event.data)
    .filter(
      (data) =>
        data.type === "subagent_started" || data.type === "subagent_ended",
    );
}

export async function loadMessageEvents(conversationId: string) {
  return (await getConversationEventStore().loadHistory(conversationId))
    .map((event) => event.data)
    .filter((data) => data.type === "message");
}

type ChildAgentArgs = {
  conversationStore: ConversationStore;
  idempotencyKey: string;
  parentConversationId: string;
  queue: ConversationWorkQueueTestAdapter;
  state: StateAdapter;
};

/** One child agent and the parent that spawned it. */
export type SpawnedChild = {
  childConversationId: string;
  parentConversationId: string;
};

/** Spawn a child agent as `spawnAgent` does. */
export async function spawnChildAgent(
  args: ChildAgentArgs,
): Promise<SpawnedChild> {
  const { childConversationId } = await spawnChild(
    {
      ...invocationInput,
      idempotencyKey: args.idempotencyKey,
      parentConversationId: args.parentConversationId,
      parentToolCallId: args.idempotencyKey,
      parentTurnId: args.idempotencyKey,
    },
    args,
  );
  return { childConversationId, parentConversationId: args.parentConversationId };
}

/**
 * Start a child agent of a parent and hold its work lease, like a child
 * worker whose run has not finished.
 */
export async function startRunningChildAgent(
  args: ChildAgentArgs,
): Promise<{ child: SpawnedChild; runId: string }> {
  const child = await spawnChildAgent(args);
  // The child worker took its wake, so a queue drain does not run it.
  args.queue.takeMessageFor(child.childConversationId);
  const lease = await startConversationWork({
    conversationId: child.childConversationId,
    conversationStore: args.conversationStore,
    state: args.state,
  });
  const runId = (
    await getConversationWorkState({
      conversationId: child.childConversationId,
      state: args.state,
    })
  )?.execution.runId;
  if (lease.status !== "acquired" || !runId) {
    throw new Error("Expected a running child agent");
  }
  return { child, runId };
}

/** Expect a stop of the parent to have stopped its running child agent. */
export async function expectChildAgentStopped(
  running: { child: SpawnedChild; runId: string },
  state: StateAdapter,
): Promise<void> {
  const { childConversationId, parentConversationId } = running.child;
  // The child worker sees this request and aborts its run.
  await expect(
    hasConversationStop({
      conversationId: childConversationId,
      runId: running.runId,
      state,
    }),
  ).resolves.toBe(true);
  await expect(listChildAgents(parentConversationId)).resolves.toContainEqual(
    expect.objectContaining({ childConversationId, status: "stopped" }),
  );
}

/** Wait until the run is aborted, then fail like an aborted agent run. */
async function waitForAbort(run: AgentRun): Promise<never> {
  const signal = run.signal;
  if (!signal) {
    throw new Error("Child run has no stop signal");
  }
  if (!signal.aborted) {
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
  }
  throw signal.reason;
}

/** Run each child until a stop aborts it, and report when it starts. */
export function abortableAgentRunner() {
  let started = deferred<void>();
  const runs: AgentRun[] = [];
  return {
    agentRunner: {
      run: async (run: AgentRun) => {
        runs.push(run);
        started.resolve(undefined);
        return await waitForAbort(run);
      },
    } satisfies AgentRunner,
    runs,
    /** Wait for the next run to start. */
    started: async () => {
      await started.promise;
      started = deferred<void>();
    },
  };
}

/**
 * Commit earlier Turns of a child, a ready summary up to the first one, and
 * enough history that the next Turn swaps the summary in at its start.
 */
export async function prepareSummarizedHistory(conversationId: string) {
  // The answers are as new as the next Turn, so only their seqs leave them
  // out of it.
  const answer = (id: string, text: string): PiMessage[] =>
    [
      {
        role: "assistant",
        content: [{ type: "toolCall", id, name: "reply", arguments: { text } }],
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: id,
        toolName: "reply",
        content: [{ type: "text", text }],
        details: { text },
        isError: false,
        timestamp: Date.now(),
      },
    ] as PiMessage[];
  const summarized = [
    {
      role: "user",
      content: [{ type: "text", text: "Read the build log." }],
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "log-1", name: "bash", arguments: {} }],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: "log-1",
      toolName: "bash",
      // Above the compaction threshold of the default context window.
      content: [{ type: "text", text: "x".repeat(1_600_000) }],
      isError: false,
    },
    ...answer("reply-1", "Read the log."),
    // Folds into a system message that, like the summary, takes the seq of
    // the swap. Kept messages keep their own seqs.
    {
      role: "system",
      content: "",
      sections: { plan: "<plan>a</plan>" },
      timestamp: 1,
    },
  ] as PiMessage[];
  const marked = await commitMessages({
    conversationId,
    messages: summarized,
  });
  await getConversationEventStore().append(conversationId, [
    {
      createdAtMs: Date.now(),
      data: {
        type: "compaction_prepared",
        markSeq: marked.committedSeq,
        historyVersion: marked.historyVersion,
        modelId: "test-model",
        outcome: "ready",
        summary: "The parent asked for the build log.",
      },
    },
  ]);
  await commitMessages({
    conversationId,
    messages: [
      ...summarized,
      {
        role: "user",
        content: [{ type: "text", text: "Check the deploy." }],
      } as PiMessage,
      ...answer("reply-2", "Earlier child result"),
    ],
  });
}

/**
 * Commit parent history with an earlier `reply` and the `spawnAgent` call of
 * a fork. Returns the id of that call.
 */
export async function prepareForkParentHistory(): Promise<string> {
  const toolCallId = "spawn-fork";
  await commitMessages({
    conversationId: parentConversationId,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Start the release." }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "parent-reply",
            name: "reply",
            arguments: { text: "Release started." },
          },
        ],
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "parent-reply",
        toolName: "reply",
        content: [{ type: "text", text: "Release started." }],
        details: { text: "Release started." },
        isError: false,
        timestamp: 3,
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: "spawnAgent",
            arguments: { fork: true, task: invocationInput.input },
          },
        ],
        stopReason: "toolUse",
        timestamp: 4,
      },
    ] as PiMessage[],
  });
  return toolCallId;
}

/** Plugins with one approved tool, `upkeep_markDone`, for child agent tests. */
export function upkeepPlugins(
  markDone: (input: { itemId: string }) => Record<string, never>,
) {
  return defineJuniorPlugins([
    defineJuniorPlugin({
      manifest: {
        name: "upkeep",
        displayName: "Upkeep",
        description: "Upkeep test tools",
      },
      hooks: {
        tools: () => ({
          markDone: definePluginTool({
            // The tool checks in code that its effect is safe, so action
            // review does not run, also in a child agent.
            approvalMode: "approve",
            exposure: "direct",
            annotations: {
              destructiveHint: true,
              idempotentHint: true,
              openWorldHint: true,
              readOnlyHint: false,
            },
            description: "Mark one item done.",
            inputSchema: z.object({ itemId: z.string() }),
            outputSchema: pluginToolOutputSchema,
            execute: markDone,
          }),
        }),
      },
    }),
  ]);
}
