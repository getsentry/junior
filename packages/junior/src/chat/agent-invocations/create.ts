import { randomUUID } from "node:crypto";
import type { StateAdapter } from "chat";
import { eq } from "drizzle-orm";
import { getConversationStoppedAtMs } from "@/chat/conversations/session-stop";
import type { ConversationStore } from "@/chat/conversations/store";
import { getConversationStore, getSqlExecutor } from "@/chat/db";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { ensureConversationWake } from "@/chat/task-execution/store";
import {
  juniorAgentBindings,
  juniorAgentInvocations,
  juniorConversations,
} from "@/db/schema";
import { getAgentBinding } from "./bindings";
import { readChildConversationSender } from "./child-input";
import { listOpenChildAgentsWithoutAgentInvocations } from "./list";
import { recordSubagentStartedMarker, type SubagentStart } from "./markers";
import {
  agentConfigSchema,
  readAgentConfig,
  type AgentConfig,
} from "@/chat/conversations/agent-config";
import { nextDetailVersion } from "@/chat/conversations/sql/detail-version";
import {
  AgentInvocationLimitError,
  AgentMessageQueueFullError,
  AgentNameInUseError,
} from "./errors";
import {
  getAgentInvocationId,
  getChildAgentLockName,
  getNamedAgentConversationId,
  getSpawnedChildConversationId,
  getUnnamedAgentConversationId,
} from "./ids";
import {
  appendParentMessage,
  buildParentMessage,
  type ParentMessageDelivery,
} from "./parent-message";
import {
  getAgentInvocation,
  getLatestAgentInvocationForConversation,
  isStoppedAgentInvocation,
  listOpenAgentInvocations,
} from "./store";
import {
  createAgentInvocationSchema,
  type AgentInvocation,
  type CreateAgentInvocationInput,
} from "./types";

/** Cap concurrent non-terminal children one parent can keep in flight. */
export const MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT = 8;
/**
 * Cap the non-terminal Agent invocations of one child, including the one that
 * runs. Each message to a busy child with a row queues one more. A child with
 * no row has no cap: its parent messages wait in its mailbox like any input.
 */
const MAX_OPEN_AGENT_INVOCATIONS_PER_CHILD = 4;

type NewAgentInvocation = Pick<
  AgentInvocation,
  | "actor"
  | "agentName"
  | "agentType"
  | "childConversationId"
  | "credentialContext"
  | "destination"
  | "fork"
  | "input"
  | "invocationId"
  | "parentConversationId"
  | "parentToolCallId"
  | "reasoningLevel"
  | "title"
> & { source?: AgentInvocation["source"] | undefined };

/**
 * Insert one pending agent invocation and read it back. An existing row with
 * the same id wins, so the caller checks that the row it reads is its own.
 */
async function insertAgentInvocation(
  invocation: NewAgentInvocation,
  nowMs: number,
): Promise<AgentInvocation | undefined> {
  await getSqlExecutor()
    .db()
    .insert(juniorAgentInvocations)
    .values({
      ...invocation,
      agentName: invocation.agentName ?? null,
      agentType: invocation.agentType ?? null,
      fork: invocation.fork ?? false,
      credentialContext: invocation.credentialContext ?? null,
      parentToolCallId: invocation.parentToolCallId ?? null,
      reasoningLevel: invocation.reasoningLevel ?? null,
      source: invocation.source ?? { kind: "agent_invocation" },
      title: invocation.title ?? null,
      status: "pending",
      mailboxStatus: "pending",
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
      terminalAt: null,
    })
    .onConflictDoNothing();
  return await getAgentInvocation(invocation.invocationId);
}

/**
 * Require every durable creation input to match before replaying one key.
 * The title is not compared: a retry can generate a different one, and the
 * stored title wins.
 */
function sameCreateInput(
  invocation: AgentInvocation,
  input: ReturnType<typeof createAgentInvocationSchema.parse>,
): boolean {
  return (
    JSON.stringify(createInputFields(invocation)) ===
    JSON.stringify(createInputFields(input))
  );
}

// The durable creation input that a replay of one idempotency key must
// match.
function createInputFields(
  input: Pick<
    AgentInvocation,
    | "actor"
    | "agentName"
    | "agentType"
    | "credentialContext"
    | "destination"
    | "fork"
    | "input"
    | "parentConversationId"
    | "reasoningLevel"
  >,
) {
  return [
    input.parentConversationId,
    input.agentName ?? null,
    input.input,
    input.agentType ?? null,
    input.fork ?? null,
    input.reasoningLevel ?? null,
    input.actor,
    input.credentialContext ?? null,
    input.destination,
  ];
}

/**
 * A stopped child agent cannot start or give work to child agents until its
 * parent gives it new work. A Turn on the child's Conversation loop
 * has no open agent invocation, but it can. A root Conversation has no agent
 * invocation or agent config, so it always passes. `open` is the parent's open work from
 * `listOpenAgentInvocations`.
 */
async function assertCanGiveChildWork(
  parentConversationId: string,
  open: readonly AgentInvocation[],
): Promise<void> {
  if (open.some((row) => row.childConversationId === parentConversationId)) {
    return;
  }
  const latest =
    await getLatestAgentInvocationForConversation(parentConversationId);
  // A child that no Agent invocation names stays stopped until new work
  // from its parent ends the stop.
  const stopped = latest
    ? isStoppedAgentInvocation(latest)
    : (await readAgentConfig(parentConversationId)) !== undefined &&
      (await getConversationStoppedAtMs(parentConversationId)) !== undefined;
  if (stopped) {
    throw new Error(
      `Agent conversation ${parentConversationId} is stopped and cannot give work to child agents`,
    );
  }
}

/**
 * Throw when giving work to one child agent would put its parent over
 * `MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT`. A child agent is active while it
 * has open work, so a busy child already counts and messages queued for it
 * do not count again. A new or idle child becomes active. This is the only
 * place the rule for which child agents count lives. `open` is the parent's
 * open work from `listOpenAgentInvocations`. A child that no agent
 * invocation names is active while its listing shows open work.
 */
async function assertChildAgentCapacity(
  open: readonly AgentInvocation[],
  args: { childConversationId: string; parentConversationId: string },
): Promise<void> {
  const active = new Set([
    ...open
      .filter((row) => row.parentConversationId === args.parentConversationId)
      .map((row) => row.childConversationId),
    ...(await listOpenChildAgentsWithoutAgentInvocations(
      args.parentConversationId,
    )),
  ]);
  if (
    !active.has(args.childConversationId) &&
    active.size >= MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT
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
 * `open` is the parent's open work from `listOpenAgentInvocations`.
 */
async function createChildAgentConversation(
  input: ReturnType<typeof createAgentInvocationSchema.parse>,
  childConversationId: string,
  open: readonly AgentInvocation[],
  nowMs: number,
): Promise<void> {
  await assertCanGiveChildWork(input.parentConversationId, open);
  if (
    input.agentName &&
    (await getAgentBinding({
      name: input.agentName,
      parentConversationId: input.parentConversationId,
    }))
  ) {
    throw new AgentNameInUseError(input.agentName);
  }
  await assertChildAgentCapacity(open, {
    childConversationId,
    parentConversationId: input.parentConversationId,
  });
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

/**
 * Create or replay the first invocation of one new child agent. A name gives
 * the child a stable Conversation id that later messages can address. A name
 * that is already used throws: later work for that child goes through
 * `createAgentInvocationForMessage`.
 */
export async function createAgentInvocation(
  rawInput: CreateAgentInvocationInput,
  nowMs = Date.now(),
): Promise<AgentInvocation> {
  const input = createAgentInvocationSchema.parse(rawInput);
  const invocationId = getAgentInvocationId(
    input.parentConversationId,
    input.idempotencyKey,
  );
  const childConversationId = input.agentName
    ? getNamedAgentConversationId(input.parentConversationId, input.agentName)
    : getUnnamedAgentConversationId(invocationId);
  // Parent-scoped lock so concurrent creates share one active-count check.
  // A stop of the parent's tree takes the same lock.
  const lockName = getChildAgentLockName(input.parentConversationId);
  return await getSqlExecutor().withLock(lockName, async () => {
    const existing = await getAgentInvocation(invocationId);
    if (existing) {
      const child = await getConversationStore().get({
        conversationId: existing.childConversationId,
      });
      if (!sameCreateInput(existing, input) || child?.kind !== input.kind) {
        throw new Error(
          `Agent invocation idempotency key was reused with different input for ${invocationId}`,
        );
      }
      return existing;
    }
    await createChildAgentConversation(
      input,
      childConversationId,
      await listOpenAgentInvocations(input.parentConversationId),
      nowMs,
    );
    const invocation = await insertAgentInvocation(
      {
        actor: input.actor,
        agentName: input.agentName,
        agentType: input.agentType,
        childConversationId,
        credentialContext: input.credentialContext,
        destination: input.destination,
        fork: input.fork,
        input: input.input,
        invocationId,
        parentConversationId: input.parentConversationId,
        parentToolCallId: input.parentToolCallId,
        reasoningLevel: input.reasoningLevel,
        title: input.title,
      },
      nowMs,
    );
    if (!invocation || !sameCreateInput(invocation, input)) {
      throw new Error(`Agent invocation creation raced for ${invocationId}`);
    }
    return invocation;
  });
}

/**
 * Create or replay the agent invocation that gives one input to a child
 * Conversation: a result or message from its own child agent, or its own
 * watch events. It continues that Conversation for the same parent as
 * `latest`, and for the same Actor and credentials unless `runAs` sets them.
 * It skips the queue and active-count checks because it continues work that
 * already passed them.
 */
export async function createAgentInvocationFromLatest(
  args: {
    input: string;
    invocationId: string;
    latest: AgentInvocation;
    /**
     * Actor, credentials, and Source for watch events and results. A parent
     * message also sets its tool call, which makes it the instruction.
     */
    runAs?: Pick<AgentInvocation, "actor" | "credentialContext"> &
      Partial<Pick<AgentInvocation, "fork" | "parentToolCallId" | "source">>;
  },
  nowMs = Date.now(),
): Promise<AgentInvocation> {
  const { latest } = args;
  const { actor, credentialContext } = args.runAs ?? latest;
  const invocation = await insertAgentInvocation(
    {
      actor,
      agentName: latest.agentName,
      agentType: latest.agentType,
      childConversationId: latest.childConversationId,
      credentialContext,
      destination: latest.destination,
      fork: args.runAs?.fork,
      input: args.input,
      invocationId: args.invocationId,
      parentConversationId: latest.parentConversationId,
      parentToolCallId: args.runAs?.parentToolCallId,
      reasoningLevel: latest.reasoningLevel,
      source: args.runAs?.source,
    },
    nowMs,
  );
  if (
    !invocation ||
    invocation.childConversationId !== latest.childConversationId
  ) {
    throw new Error(`Agent invocation creation raced for ${args.invocationId}`);
  }
  return invocation;
}

/**
 * Create or replay the agent invocation for one message from a parent to one
 * of its child agents. The child continues its history. If the child already
 * has open work, the new agent invocation waits for that work and the parent
 * gets one report for both. A stopped child starts again.
 */
export async function createAgentInvocationForMessage(
  input: {
    actor: AgentInvocation["actor"];
    childConversationId: string;
    credentialContext?: AgentInvocation["credentialContext"];
    destination: AgentInvocation["destination"];
    idempotencyKey: string;
    input: string;
    parentConversationId: string;
    parentToolCallId: string;
  },
  nowMs = Date.now(),
): Promise<{ invocation: AgentInvocation; queued: boolean }> {
  const invocationId = getAgentInvocationId(
    input.parentConversationId,
    input.idempotencyKey,
  );
  return await getSqlExecutor().withLock(
    getChildAgentLockName(input.parentConversationId),
    async () => {
      const existing = await getAgentInvocation(invocationId);
      if (existing) {
        if (
          existing.childConversationId !== input.childConversationId ||
          existing.input !== input.input
        ) {
          throw new Error(
            `Agent invocation idempotency key was reused with different input for ${invocationId}`,
          );
        }
        // A replayed pending agent invocation is queued while older open
        // work on the child runs.
        const queued =
          existing.status === "pending" &&
          (await listOpenAgentInvocations(input.parentConversationId)).some(
            (row) =>
              row.childConversationId === input.childConversationId &&
              row.createdAtMs < existing.createdAtMs,
          );
        return { invocation: existing, queued };
      }
      // A child that no agent invocation names reads its name from its
      // binding and its model settings from its agent config.
      const latest = await getLatestAgentInvocationForConversation(
        input.childConversationId,
      );
      const child =
        latest ??
        (await readChildConversationSender(input.childConversationId));
      if (!child || child.parentConversationId !== input.parentConversationId) {
        throw new Error(
          `${input.childConversationId} is not a child agent of ${input.parentConversationId}`,
        );
      }
      const agentConfig =
        latest ?? (await readAgentConfig(input.childConversationId)) ?? {};
      const open = await listOpenAgentInvocations(input.parentConversationId);
      await assertCanGiveChildWork(input.parentConversationId, open);
      const openCount = open.filter(
        (row) => row.childConversationId === input.childConversationId,
      ).length;
      // TODO(#3060 step 7): delete with rows
      if (latest && openCount >= MAX_OPEN_AGENT_INVOCATIONS_PER_CHILD) {
        throw new AgentMessageQueueFullError(
          MAX_OPEN_AGENT_INVOCATIONS_PER_CHILD,
        );
      }
      await assertChildAgentCapacity(open, {
        childConversationId: input.childConversationId,
        parentConversationId: input.parentConversationId,
      });
      // A busy child reads the message after its current work. A child with
      // no row is busy while the status reader shows it `running`.
      const queued =
        openCount > 0 ||
        (!latest &&
          (
            await listOpenChildAgentsWithoutAgentInvocations(
              input.parentConversationId,
            )
          ).includes(input.childConversationId));
      const invocation = await insertAgentInvocation(
        {
          actor: input.actor,
          agentName: child.agentName,
          agentType: agentConfig.agentType,
          childConversationId: input.childConversationId,
          credentialContext: input.credentialContext,
          destination: input.destination,
          input: input.input,
          invocationId,
          parentConversationId: input.parentConversationId,
          parentToolCallId: input.parentToolCallId,
          reasoningLevel: agentConfig.reasoningLevel,
        },
        nowMs,
      );
      if (!invocation) {
        throw new Error(`Agent invocation creation raced for ${invocationId}`);
      }
      return { invocation, queued };
    },
  );
}

type ChildAgentWorkOptions = {
  conversationStore?: ConversationStore | undefined;
  queue: ConversationWorkQueue;
  state?: StateAdapter | undefined;
};

/**
 * Give one task or message to a child agent with no Agent invocation. Under
 * the parent lock, `prepare` runs the checks of its caller. Unless it finds
 * a spawn replay, the parent's `subagent_started` marker and the parent
 * message are written, and the child's `lastTaskedAt` when the message is
 * new. The message reaches the mailbox under the lock, so the next spawn
 * counts the child as active. The wake runs after the lock commits, so the
 * child's worker reads the new Conversation; a lost wake is recovered like
 * any other stranded mailbox input.
 */
async function giveChildAgentWork<T>(
  work: Parameters<typeof buildParentMessage>[0] &
    Pick<SubagentStart, "agentName" | "reasoningLevel" | "title">,
  options: ChildAgentWorkOptions,
  prepare: (open: AgentInvocation[]) => Promise<{
    delivery: ParentMessageDelivery | "replay";
    value: T;
  }>,
): Promise<T> {
  const message = buildParentMessage(work);
  const prepared = await getSqlExecutor().withLock(
    getChildAgentLockName(work.parentConversationId),
    async () => {
      const prepared = await prepare(
        await listOpenAgentInvocations(work.parentConversationId),
      );
      if (prepared.delivery === "replay") {
        return prepared;
      }
      // The marker pairs by the parent message id, so the child's end finds
      // it by key.
      await recordSubagentStartedMarker({
        agentName: work.agentName,
        childConversationId: work.childConversationId,
        createdAtMs: work.nowMs,
        input: work.text,
        invocationId: message.inboundMessageId,
        parentConversationId: work.parentConversationId,
        parentToolCallId: work.parentToolCallId,
        reasoningLevel: work.reasoningLevel,
        title: work.title,
      });
      if (await appendParentMessage(message, prepared.delivery, options)) {
        await getSqlExecutor()
          .db()
          .update(juniorConversations)
          .set({
            detailVersion: nextDetailVersion,
            lastTaskedAt: new Date(work.nowMs),
          })
          .where(
            eq(juniorConversations.conversationId, work.childConversationId),
          );
      }
      return prepared;
    },
  );
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

/** Build the agent config that a spawn with no Agent invocation stores. */
function spawnAgentConfig(
  input: ReturnType<typeof createAgentInvocationSchema.parse>,
): AgentConfig {
  return agentConfigSchema.parse({
    ...(input.agentType ? { agentType: input.agentType } : undefined),
    ...(input.fork ? { fork: true } : undefined),
    ...(input.reasoningLevel
      ? { reasoningLevel: input.reasoningLevel }
      : undefined),
  });
}

/**
 * Check a spawn replay against the child that the first spawn stored: its
 * kind, its name, and its agent config. A replay sends nothing, so the first
 * task, Actor, and credentials stay, and other input there gains no
 * authority.
 */
async function assertSameSpawn(
  input: ReturnType<typeof createAgentInvocationSchema.parse>,
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
 * Create or replay one child agent without an Agent invocation row: its
 * Conversation, its binding, its agent config, and its task as a parent
 * message. The spawn's idempotency key names the child Conversation, so a
 * replay finds it in SQL and sends nothing. The child exists in SQL only
 * when its task reached its mailbox in the same transaction.
 *
 * TODO(dcramer): Make this the only spawn when #3060 step 7 drops the agent
 * invocation table.
 */
export async function spawnChildAgent(
  rawInput: CreateAgentInvocationInput & { parentToolCallId: string },
  options: ChildAgentWorkOptions,
  nowMs = Date.now(),
): Promise<{ childConversationId: string }> {
  const input = createAgentInvocationSchema.parse(rawInput);
  const childConversationId = getSpawnedChildConversationId(
    input.parentConversationId,
    input.idempotencyKey,
  );
  await giveChildAgentWork(
    {
      ...input,
      childConversationId,
      nowMs,
      parentToolCallId: rawInput.parentToolCallId,
      text: input.input,
      trustedSummary: "Your parent agent sent a task.",
    },
    options,
    async (open) => {
      const child = await getConversationStore().get({
        conversationId: childConversationId,
      });
      if (child) {
        await assertSameSpawn(input, child);
        return { delivery: "replay", value: undefined };
      }
      await createChildAgentConversation(
        input,
        childConversationId,
        open,
        nowMs,
      );
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
 * Give one `messageAgent` message to a child agent that no Agent invocation
 * names, as a parent message. `findChildAgentConversationId` must have found
 * the child under this parent. `queued` is true when the child already has
 * open work, so it reads the message after that work.
 */
export async function messageChildAgent(
  input: {
    actor: AgentInvocation["actor"];
    childConversationId: string;
    credentialContext?: AgentInvocation["credentialContext"];
    idempotencyKey: string;
    input: string;
    parentConversationId: string;
    parentToolCallId: string;
  },
  options: ChildAgentWorkOptions,
  nowMs = Date.now(),
): Promise<{ queued: boolean }> {
  const sender = await readChildConversationSender(input.childConversationId);
  const queued = await giveChildAgentWork(
    {
      ...input,
      agentName: sender?.agentName,
      nowMs,
      text: input.input,
      title: sender?.title,
      trustedSummary: "Your parent agent sent a message.",
    },
    options,
    async (open) => {
      await assertCanGiveChildWork(input.parentConversationId, open);
      await assertChildAgentCapacity(open, {
        childConversationId: input.childConversationId,
        parentConversationId: input.parentConversationId,
      });
      return {
        delivery: "message",
        value: (
          await listOpenChildAgentsWithoutAgentInvocations(
            input.parentConversationId,
          )
        ).includes(input.childConversationId),
      };
    },
  );
  return { queued };
}
