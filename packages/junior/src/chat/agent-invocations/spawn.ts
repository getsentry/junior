import type { StateAdapter } from "chat";
import type { ConversationStore } from "@/chat/conversations/store";
import type { Actor } from "@sentry/junior-plugin-api";
import type {
  AgentRun,
  SpawnAgent,
  SpawnAgentInput,
  SpawnAgentResult,
} from "@/chat/agent/types";
import { actorFromRun, toolInvocationDestination } from "@/chat/agent/types";
import { botConfig } from "@/chat/config";
import { readConversationLineage } from "@/chat/conversations/lineage";
import { opensChildChannel } from "@/chat/conversations/kind-behavior";
import { getConversationStore } from "@/chat/db";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { getConversationWorkState } from "@/chat/task-execution/store";
import {
  findOpenChannelThread,
  isChannelThread,
} from "@/chat/conversations/channel-thread";
import {
  bindThreadCodeChannel,
  createThreadCodeChannel,
  readCodeChannelOrigin,
} from "@/chat/slack/code-channel/open";
import { getAgentBinding } from "./bindings";
import {
  assertCanCreateChildWithoutAgentInvocation,
  createChildWithoutAgentInvocation,
  newChildAgentConversationId,
} from "./create";
import { appendParentMessage } from "./parent-message";
import { AgentDepthLimitError } from "./errors";
import {
  getAgentInvocationId,
  getAgentInvocationMessageId,
  getUnnamedAgentConversationId,
} from "./ids";
import { getAgentInvocation } from "./store";
import { createAndEnqueueAgentInvocation } from "./work";

type SpawnOptions = {
  conversationStore?: ConversationStore;
  /**
   * How many levels of child agents can start their own child agents. The
   * default comes from `limits.maxAgentDepth`. 0 lets only the root start them.
   */
  maxAgentDepth?: number;
  queue: ConversationWorkQueue | (() => ConversationWorkQueue);
  state?: StateAdapter;
};

/**
 * Count the parents of the Conversation that starts a child agent. A chain
 * that does not end at a root, such as a cycle, cannot start one.
 */
async function assertCanStartChildAgent(
  conversationId: string,
  maxAgentDepth: number,
): Promise<void> {
  const lineage = await readConversationLineage(conversationId);
  const root = lineage[0];
  // A channel Thread acts as a root in its channel, so depth counts from it.
  // It is always a direct child of a root.
  const anchor = lineage[1] && (await isChannelThread(lineage[1])) ? 1 : 0;
  if (
    !root ||
    root.parentConversationId ||
    lineage.length - 1 - anchor > maxAgentDepth
  ) {
    throw new AgentDepthLimitError(maxAgentDepth);
  }
}

/**
 * Return the child of a spawn that already ran without an agent invocation.
 * Its idempotency key keys the task in the child's mailbox. A spawn with an
 * agent invocation replays through that row instead.
 */
async function findSpawnedChildAgent(args: {
  agentName?: string;
  idempotencyKey: string;
  parentConversationId: string;
  state?: StateAdapter;
}): Promise<string | undefined> {
  const invocationId = getAgentInvocationId(
    args.parentConversationId,
    args.idempotencyKey,
  );
  if (await getAgentInvocation(invocationId)) {
    return undefined;
  }
  const childConversationId = args.agentName
    ? (
        await getAgentBinding({
          name: args.agentName,
          parentConversationId: args.parentConversationId,
        })
      )?.childConversationId
    : getUnnamedAgentConversationId(invocationId);
  if (!childConversationId) {
    return undefined;
  }
  const work = await getConversationWorkState({
    conversationId: childConversationId,
    state: args.state,
  });
  return work?.execution.inboundMessageIds.includes(
    getAgentInvocationMessageId(invocationId),
  )
    ? childConversationId
    : undefined;
}

/**
 * Start a Thread as a channel Thread when it can get a code channel, or give
 * the task to the open channel Thread of this root: one origin thread has at
 * most one. A channel Thread gets its work as parent messages and has no
 * Agent invocation, so no result of it reaches the parent. Returns undefined
 * when the Thread must start as a plain Thread.
 */
async function spawnChannelThread(args: {
  actor: Actor;
  call: { toolCallId: string };
  idempotencyKey: string;
  input: SpawnAgentInput;
  queue: ConversationWorkQueue;
  run: AgentRun;
  /** A replayed spawn that already gave its task to this child. */
  spawned?: string;
  state?: StateAdapter;
}): Promise<SpawnAgentResult | undefined> {
  const { input, run } = args;
  const sendTask = async (childConversationId: string) =>
    await appendParentMessage({
      actor: args.actor,
      childConversationId,
      ...(run.credentialContext
        ? { credentialContext: run.credentialContext }
        : undefined),
      ...(input.fork ? { fork: true as const } : undefined),
      idempotencyKey: args.idempotencyKey,
      parentConversationId: run.conversationId,
      parentToolCallId: args.call.toolCallId,
      queue: args.queue,
      state: args.state,
      text: input.task,
    });
  const open = await findOpenChannelThread(run.conversationId);
  if (open) {
    if (args.spawned !== open.conversationId) {
      await sendTask(open.conversationId);
    }
    return {
      childConversationId: open.conversationId,
      channel: {
        id: open.providerDestinationId,
        reused: args.spawned !== open.conversationId,
      },
    };
  }
  if (args.spawned) return undefined;
  const origin = await readCodeChannelOrigin(run);
  if (!origin) return undefined;
  const child = {
    agentConfig: {
      ...(input.agentType ? { agentType: input.agentType } : undefined),
      ...(input.fork ? { fork: true as const } : undefined),
      ...(input.reasoningLevel
        ? { reasoningLevel: input.reasoningLevel }
        : undefined),
    },
    ...(input.name ? { agentName: input.name } : undefined),
    idempotencyKey: args.idempotencyKey,
    kind: "thread" as const,
    parentConversationId: run.conversationId,
    ...(input.title ? { title: input.title } : undefined),
  };
  // Check the limits first: a refused spawn must not leave a code channel,
  // and its card, behind.
  await assertCanCreateChildWithoutAgentInvocation(child);
  const threadConversationId = newChildAgentConversationId(child);
  const channelId = await createThreadCodeChannel({
    origin,
    threadConversationId,
  });
  if (!channelId) return undefined;
  await createChildWithoutAgentInvocation(child);
  await bindThreadCodeChannel({
    channelId,
    teamId: origin.teamId,
    threadConversationId,
  });
  await sendTask(threadConversationId);
  return {
    childConversationId: threadConversationId,
    channel: { id: channelId, reused: false },
  };
}

/** Bind a Run's Actor and credentials to new Agent invocations. */
export function bindSpawnAgent(
  run: AgentRun,
  options: SpawnOptions,
): SpawnAgent | undefined {
  const actor = actorFromRun(run);
  if (!actor) {
    return undefined;
  }
  return async (
    input: SpawnAgentInput,
    call: { signal?: AbortSignal; toolCallId: string },
  ) => {
    call.signal?.throwIfAborted();
    await assertCanStartChildAgent(
      run.conversationId,
      options.maxAgentDepth ?? botConfig.maxAgentDepth,
    );
    const idempotencyKey = `${run.turnId}:${call.toolCallId}`;
    const spawned = await findSpawnedChildAgent({
      ...(input.name ? { agentName: input.name } : undefined),
      idempotencyKey,
      parentConversationId: run.conversationId,
      state: options.state,
    });
    const queue =
      typeof options.queue === "function" ? options.queue() : options.queue;
    const parent = await getConversationStore().get({
      conversationId: run.conversationId,
    });
    if (
      input.kind &&
      parent &&
      opensChildChannel({ childKind: input.kind, parentKind: parent.kind })
    ) {
      const channelThread = await spawnChannelThread({
        actor,
        call,
        idempotencyKey,
        input,
        queue,
        run,
        ...(spawned ? { spawned } : undefined),
        state: options.state,
      });
      if (channelThread) {
        return channelThread;
      }
    }
    if (spawned) {
      return { childConversationId: spawned };
    }
    const invocation = await createAndEnqueueAgentInvocation(
      {
        actor,
        ...(input.name ? { agentName: input.name } : undefined),
        ...(input.agentType ? { agentType: input.agentType } : undefined),
        ...(input.fork ? { fork: true as const } : undefined),
        ...(run.credentialContext
          ? { credentialContext: run.credentialContext }
          : undefined),
        destination: toolInvocationDestination(run),
        idempotencyKey,
        input: input.task,
        ...(input.kind ? { kind: input.kind } : undefined),
        parentConversationId: run.conversationId,
        parentToolCallId: call.toolCallId,
        ...(input.reasoningLevel
          ? { reasoningLevel: input.reasoningLevel }
          : undefined),
        ...(input.title ? { title: input.title } : undefined),
      },
      { ...options, queue },
    );
    return {
      childConversationId: invocation.childConversationId,
    };
  };
}
