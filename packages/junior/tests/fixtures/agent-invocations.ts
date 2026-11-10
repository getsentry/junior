/** Shared parent Conversation setup for agent invocation integration tests. */
import type { StateAdapter } from "chat";
import { expect } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { listChildAgents } from "@/chat/agent-invocations/list";
import { getAgentInvocation } from "@/chat/agent-invocations/store";
import type { AgentInvocation } from "@/chat/agent-invocations/types";
import { createAndEnqueueAgentInvocation } from "@/chat/agent-invocations/work";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import type { ConversationStore } from "@/chat/conversations/store";
import { getConversationEventStore, getSqlExecutor } from "@/chat/db";
import { resultDeliveryFor } from "@/chat/agent-invocations/statuses";
import { juniorAgentInvocations } from "@/db/schema";
import {
  getConversationWorkState,
  hasConversationStop,
  startConversationWork,
} from "@/chat/task-execution/store";
import type { AgentRun } from "@/chat/agent/types";
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
  destination,
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
  destination: slackDestination,
  parentConversationId: slackParentConversationId,
};

/**
 * Each write of `parent_mailbox_status` must also write `result_delivery`,
 * so every scenario checks both columns, and `kind`, before it closes.
 */
function createCheckedSqlFixture() {
  const fixture = createConfiguredJuniorSqlFixture();
  return {
    ...fixture,
    close: async () => {
      try {
        const rows = await getSqlExecutor()
          .db()
          .select()
          .from(juniorAgentInvocations);
        expect(
          rows.map((row) => [row.invocationId, row.kind, row.resultDelivery]),
        ).toEqual(
          rows.map((row) => [
            row.invocationId,
            row.parentToolCallId === null ? "own_work" : "parent_task",
            row.parentMailboxStatus
              ? resultDeliveryFor(row.parentMailboxStatus)
              : null,
          ]),
        );
      } finally {
        await fixture.close();
      }
    },
  };
}

export async function prepareParentConversation() {
  const fixture = createCheckedSqlFixture();
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
  const fixture = createCheckedSqlFixture();
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

/** Spawn a child agent that reports to the destination of the parent's run. */
export async function spawnChildAgent(
  args: ChildAgentArgs,
): Promise<AgentInvocation> {
  const destination = (
    await getConversationWorkState({
      conversationId: args.parentConversationId,
      state: args.state,
    })
  )?.destination;
  if (!destination) {
    throw new Error("Expected a parent Conversation with a destination");
  }
  return await createAndEnqueueAgentInvocation(
    {
      ...invocationInput,
      destination,
      idempotencyKey: args.idempotencyKey,
      parentConversationId: args.parentConversationId,
    },
    args,
  );
}

/**
 * Start a child agent of a parent and hold its work lease, like a child
 * worker whose run has not finished.
 */
export async function startRunningChildAgent(
  args: ChildAgentArgs,
): Promise<{ invocation: AgentInvocation; runId: string }> {
  const invocation = await spawnChildAgent(args);
  // The child worker took its wake, so a queue drain does not run it.
  args.queue.takeMessageFor(invocation.childConversationId);
  const lease = await startConversationWork({
    conversationId: invocation.childConversationId,
    conversationStore: args.conversationStore,
    state: args.state,
  });
  const runId = (
    await getConversationWorkState({
      conversationId: invocation.childConversationId,
      state: args.state,
    })
  )?.execution.runId;
  if (lease.status !== "acquired" || !runId) {
    throw new Error("Expected a running child agent");
  }
  return { invocation, runId };
}

/** Expect a stop of the parent to have stopped its running child agent. */
export async function expectChildAgentStopped(
  child: { invocation: AgentInvocation; runId: string },
  state: StateAdapter,
): Promise<void> {
  const { childConversationId, invocationId, parentConversationId } =
    child.invocation;
  await expect(getAgentInvocation(invocationId)).resolves.toMatchObject({
    errorMessage: "Stopped by the parent conversation",
    parentMailboxStatus: "skipped",
    status: "stopped",
  });
  // The child worker sees this request and aborts its run.
  await expect(
    hasConversationStop({
      conversationId: childConversationId,
      runId: child.runId,
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
