import { randomUUID } from "node:crypto";
import type { StateAdapter } from "chat";
import { eq } from "drizzle-orm";
import { addConversationNote } from "@/chat/conversations/notes";
import { getConversationStoppedAtMs } from "@/chat/conversations/session-stop";
import type { ConversationStore } from "@/chat/conversations/store";
import { loadTurnStart } from "@/chat/conversations/turn-lifecycle";
import type { CredentialContext } from "@/chat/credentials/context";
import { getConversationStore, getSqlExecutor } from "@/chat/db";
import type { Actor } from "@/chat/actor";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  ensureConversationWake,
  getConversationWorkState,
  hasConversationStop,
} from "@/chat/task-execution/store";
import { juniorAgentBindings, juniorConversations } from "@/db/schema";
import { getAgentBinding } from "./bindings";
import { readChildConversationSender } from "./child-input";
import { listOpenChildAgents } from "./list";
import { recordSubagentStartedMarker, type SubagentStart } from "./markers";
import {
  agentConfigSchema,
  readAgentConfig,
  type AgentConfig,
} from "@/chat/conversations/agent-config";
import { nextDetailVersion } from "@/chat/conversations/sql/detail-version";
import {
  AgentInvocationLimitError,
  AgentNameInUseError,
  AgentStoppedError,
} from "./errors";
import { getChildAgentLockName, getSpawnedChildConversationId } from "./ids";
import {
  appendParentMessage,
  buildParentMessage,
  type ParentMessageDelivery,
} from "./parent-message";
import { spawnChildAgentInputSchema, type SpawnChildAgentInput } from "./types";

/** Cap concurrent active children one parent can keep in flight. */
export const MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT = 8;

type SpawnInput = ReturnType<typeof spawnChildAgentInputSchema.parse>;

/**
 * A stopped child agent cannot start or give work to child agents until its
 * parent gives it new work, which ends the stop. A root Conversation has no
 * agent config, so it always passes.
 */
async function assertCanGiveChildWork(
  parentConversationId: string,
): Promise<void> {
  if (
    (await readAgentConfig(parentConversationId)) !== undefined &&
    (await getConversationStoppedAtMs(parentConversationId)) !== undefined
  ) {
    throw new AgentStoppedError();
  }
}

/**
 * Throw when giving work to one child agent would put its parent over
 * `MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT`. A child agent is active while
 * its listing shows open work, so a busy child already counts and messages
 * queued for it do not count again. A new or idle child becomes active. This
 * is the only place the rule for which child agents count lives. `active` is
 * the parent's active children from `listOpenChildAgents`.
 */
function assertChildAgentCapacity(
  active: readonly string[],
  childConversationId: string,
): void {
  if (
    !active.includes(childConversationId) &&
    active.length >= MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT
  ) {
    throw new AgentInvocationLimitError(
      MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT,
    );
  }
}

/**
 * Create the Conversation of one new child agent and bind its name, after
 * the checks that every new child passes: its parent can give work, the name
 * is free, and the parent has room. Call it under the parent lock, in the
 * same transaction, so no other create can take this name or room first.
 */
async function createChildAgentConversation(
  input: SpawnInput,
  childConversationId: string,
  nowMs: number,
): Promise<void> {
  await assertCanGiveChildWork(input.parentConversationId);
  if (
    input.agentName &&
    (await getAgentBinding({
      name: input.agentName,
      parentConversationId: input.parentConversationId,
    }))
  ) {
    throw new AgentNameInUseError(input.agentName);
  }
  assertChildAgentCapacity(
    await listOpenChildAgents(input.parentConversationId),
    childConversationId,
  );
  await getConversationStore().createChild({
    childConversationId,
    kind: input.kind,
    parentConversationId: input.parentConversationId,
    nowMs,
    source: "internal",
    // The spawn title names the child, so title generation skips it.
    ...(input.title ? { title: input.title } : undefined),
  });
  if (input.agentName) {
    await getSqlExecutor().db().insert(juniorAgentBindings).values({
      childConversationId,
      name: input.agentName,
      parentConversationId: input.parentConversationId,
    });
  }
}

type ChildAgentWorkOptions = {
  conversationStore?: ConversationStore | undefined;
  queue: ConversationWorkQueue;
  state?: StateAdapter | undefined;
};

/**
 * Give one task or message to a child agent. Under
 * the parent lock, `prepare` runs the checks of its caller. Unless it finds
 * a spawn replay or leaves a note, the parent's `subagent_started` marker
 * and the parent message are written. The message reaches the mailbox under
 * the lock, so the next spawn counts the child as active. The wake runs
 * after the lock commits, so the child's worker reads the new Conversation;
 * a lost wake is recovered like any other stranded mailbox input.
 */
async function giveChildAgentWork<T>(
  work: Parameters<typeof buildParentMessage>[0] &
    Pick<SubagentStart, "agentName" | "reasoningLevel" | "title">,
  options: ChildAgentWorkOptions,
  prepare: () => Promise<{
    delivery: ParentMessageDelivery | "noted" | "replay";
    value: T;
  }>,
): Promise<T> {
  const message = buildParentMessage(work);
  const prepared = await getSqlExecutor().withLock(
    getChildAgentLockName(work.parentConversationId),
    async () => {
      const prepared = await prepare();
      if (prepared.delivery === "noted" || prepared.delivery === "replay") {
        return prepared;
      }
      // The marker pairs by the parent message id, so the child's end finds
      // it by key.
      await recordSubagentStartedMarker({
        agentName: work.agentName,
        childConversationId: work.childConversationId,
        createdAtMs: work.nowMs,
        input: work.text,
        markerId: message.inboundMessageId,
        parentConversationId: work.parentConversationId,
        parentToolCallId: work.parentToolCallId,
        reasoningLevel: work.reasoningLevel,
        title: work.title,
      });
      await appendParentMessage(message, prepared.delivery, options);
      return prepared;
    },
  );
  if (prepared.delivery === "noted") {
    return prepared.value;
  }
  await ensureConversationWake({
    conversationId: work.childConversationId,
    conversationStore: options.conversationStore,
    // The only earlier wake of a new child came from a spawn that rolled
    // back, and it may be spent, so a new child gets its own.
    ...(prepared.delivery === "new_child"
      ? {
          idempotencyKey: `${message.inboundMessageId}:${randomUUID()}`,
          ignoreEnqueueMarker: true,
        }
      : { idempotencyKey: message.inboundMessageId }),
    queue: options.queue,
    state: options.state,
  });
  return prepared.value;
}

/** Build the agent config that a spawn stores. */
function spawnAgentConfig(input: SpawnInput): AgentConfig {
  return agentConfigSchema.parse({
    ...(input.agentType ? { agentType: input.agentType } : undefined),
    ...(input.fork ? { fork: true } : undefined),
    ...(input.reasoningLevel
      ? { reasoningLevel: input.reasoningLevel }
      : undefined),
  });
}

/**
 * Return whether a Conversation's current Turn is stopped: its run has a stop
 * request, or the stop came after the Turn started. A stop's time is when its
 * message was sent, so a Turn that started before the stop arrived still has
 * the stop request. Any other stop from before the Turn does not count: a
 * later Turn runs past it, such as one for the reply of a Thread that a
 * person resumed. With no record of the Turn's start, any stop counts.
 */
async function isStoppedInTurn(
  conversationId: string,
  turnId: string,
  state: StateAdapter | undefined,
): Promise<boolean> {
  // A stop request on the current run stops it even after a person resumed
  // the Conversation.
  const runId = (await getConversationWorkState({ conversationId, state }))
    ?.execution.runId;
  if (runId && (await hasConversationStop({ conversationId, runId, state }))) {
    return true;
  }
  const stoppedAtMs = await getConversationStoppedAtMs(conversationId);
  if (stoppedAtMs === undefined) {
    return false;
  }
  const start = await loadTurnStart(conversationId, turnId);
  return start === undefined || stoppedAtMs >= start.startedAtMs;
}

/**
 * Check a spawn replay against the child that the first spawn stored: its
 * kind, its name, and its agent config. A replay sends nothing, so the first
 * task, Actor, and credentials stay, and other input there gains no
 * authority.
 */
async function assertSameSpawn(
  input: SpawnInput,
  child: { conversationId: string; kind: string },
): Promise<void> {
  const [sender, config] = await Promise.all([
    readChildConversationSender(child.conversationId),
    readAgentConfig(child.conversationId),
  ]);
  const expected = spawnAgentConfig(input);
  if (
    child.kind !== input.kind ||
    sender?.agentName !== input.agentName ||
    config?.agentType !== expected.agentType ||
    config?.fork !== expected.fork ||
    config?.reasoningLevel !== expected.reasoningLevel
  ) {
    throw new Error(
      `Spawn idempotency key was reused with different input for ${child.conversationId}`,
    );
  }
}

/**
 * Create or replay one child agent: its Conversation, its binding, its agent
 * config, and its task as a parent message. The spawn's idempotency key
 * names the child Conversation, so a replay finds it in SQL and sends
 * nothing. The child exists in SQL only when its task reached its mailbox in
 * the same transaction.
 */
export async function spawnChildAgent(
  rawInput: SpawnChildAgentInput & { parentTurnId: string },
  options: ChildAgentWorkOptions,
  nowMs = Date.now(),
): Promise<{ childConversationId: string }> {
  const { parentTurnId, ...spawnInput } = rawInput;
  const input = spawnChildAgentInputSchema.parse(spawnInput);
  const childConversationId = getSpawnedChildConversationId(
    input.parentConversationId,
    input.idempotencyKey,
  );
  await giveChildAgentWork(
    {
      ...input,
      childConversationId,
      nowMs,
      text: input.input,
    },
    options,
    async () => {
      const child = await getConversationStore().get({
        conversationId: childConversationId,
      });
      if (child) {
        await assertSameSpawn(input, child);
        return { delivery: "replay", value: undefined };
      }
      // A new child has no Turn to read a note, so a stopped parent cannot
      // start one.
      if (
        await isStoppedInTurn(
          input.parentConversationId,
          parentTurnId,
          options.state,
        )
      ) {
        throw new AgentStoppedError();
      }
      await createChildAgentConversation(input, childConversationId, nowMs);
      await getSqlExecutor()
        .db()
        .update(juniorConversations)
        .set({
          agentConfig: spawnAgentConfig(input),
          detailVersion: nextDetailVersion,
        })
        .where(eq(juniorConversations.conversationId, childConversationId));
      return { delivery: "new_child", value: undefined };
    },
  );
  return { childConversationId };
}

/**
 * Give one `messageAgent` message to a child agent, as a parent message. `findChildAgentConversationId` must have found
 * the child under this parent. `queued` means the child already has open
 * work. A running Turn that this parent started reads the message at its
 * next model call when the message has the Turn's Actor and credentials;
 * otherwise the child reads it after that work. While the parent is
 * stopped, the message becomes a Conversation note on the child instead: it
 * starts no work and ends no stop, and the child's next Turn shows it.
 */
export async function messageChildAgent(
  input: {
    actor: Actor;
    childConversationId: string;
    credentialContext?: CredentialContext | undefined;
    idempotencyKey: string;
    input: string;
    parentConversationId: string;
    parentToolCallId: string;
    parentTurnId: string;
  },
  options: ChildAgentWorkOptions,
  nowMs = Date.now(),
): Promise<{ delivery: "noted" | "queued" | "started" }> {
  const { parentTurnId, ...work } = input;
  const sender = await readChildConversationSender(input.childConversationId);
  const delivery = await giveChildAgentWork(
    {
      ...work,
      agentName: sender?.agentName,
      nowMs,
      text: input.input,
      title: sender?.title,
    },
    options,
    async () => {
      if (
        await isStoppedInTurn(
          input.parentConversationId,
          parentTurnId,
          options.state,
        )
      ) {
        await addConversationNote({
          conversationId: input.childConversationId,
          createdAtMs: nowMs,
          key: `stopped-parent-message:${input.parentConversationId}:${input.idempotencyKey}`,
          text: `Your parent agent sent this message while it was stopped, so it started no work: ${input.input}`,
        });
        return { delivery: "noted", value: "noted" as const };
      }
      await assertCanGiveChildWork(input.parentConversationId);
      const active = await listOpenChildAgents(input.parentConversationId);
      assertChildAgentCapacity(active, input.childConversationId);
      const queued = active.includes(input.childConversationId);
      return {
        delivery: "message",
        value: queued ? ("queued" as const) : ("started" as const),
      };
    },
  );
  return { delivery };
}
