import { getConversationStore, getSqlExecutor } from "@/chat/db";
import { juniorAgentBindings, juniorAgentInvocations } from "@/db/schema";
import { getAgentBinding } from "./bindings";
import {
  AgentInvocationLimitError,
  AgentMessageQueueFullError,
  AgentNameInUseError,
} from "./errors";
import {
  getAgentInvocationId,
  getChildAgentLockName,
  getNamedAgentConversationId,
  getUnnamedAgentConversationId,
} from "./ids";
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
 * Cap the non-terminal agent invocations of one child, including the one that
 * runs. Each message to a busy child queues one more.
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
> & { source?: AgentInvocation["source"] };

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
    invocation.parentConversationId === input.parentConversationId &&
    invocation.agentName === input.agentName &&
    invocation.input === input.input &&
    invocation.agentType === input.agentType &&
    invocation.fork === input.fork &&
    invocation.reasoningLevel === input.reasoningLevel &&
    JSON.stringify(invocation.actor) === JSON.stringify(input.actor) &&
    JSON.stringify(invocation.credentialContext) ===
      JSON.stringify(input.credentialContext) &&
    JSON.stringify(invocation.destination) === JSON.stringify(input.destination)
  );
}

/**
 * A stopped child agent cannot start or give work to child agents until its
 * parent gives it new work. A Turn on the child's Conversation loop
 * has no open agent invocation, but it can. A root Conversation has no agent
 * invocation, so it always passes. `open` is the parent's open work from
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
  if (latest && isStoppedAgentInvocation(latest)) {
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
 * open work from `listOpenAgentInvocations`.
 */
function assertChildAgentCapacity(
  open: readonly AgentInvocation[],
  args: { childConversationId: string; parentConversationId: string },
): void {
  const active = new Set(
    open
      .filter((row) => row.parentConversationId === args.parentConversationId)
      .map((row) => row.childConversationId),
  );
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
    const open = await listOpenAgentInvocations(input.parentConversationId);
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
    assertChildAgentCapacity(open, {
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

    // The name check above runs under the parent lock, in the same
    // transaction, so no other create can take this name first.
    if (input.agentName) {
      await getSqlExecutor().db().insert(juniorAgentBindings).values({
        childConversationId,
        name: input.agentName,
        parentConversationId: input.parentConversationId,
      });
    }

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
    /** Actor, credentials, and Source for watch events and results. */
    runAs?: Pick<AgentInvocation, "actor" | "credentialContext"> &
      Partial<Pick<AgentInvocation, "source">>;
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
      input: args.input,
      invocationId: args.invocationId,
      parentConversationId: latest.parentConversationId,
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
      const latest = await getLatestAgentInvocationForConversation(
        input.childConversationId,
      );
      if (
        !latest ||
        latest.parentConversationId !== input.parentConversationId
      ) {
        throw new Error(
          `${input.childConversationId} is not a child agent of ${input.parentConversationId}`,
        );
      }
      const open = await listOpenAgentInvocations(input.parentConversationId);
      await assertCanGiveChildWork(input.parentConversationId, open);
      const openCount = open.filter(
        (row) => row.childConversationId === input.childConversationId,
      ).length;
      if (openCount >= MAX_OPEN_AGENT_INVOCATIONS_PER_CHILD) {
        throw new AgentMessageQueueFullError(
          MAX_OPEN_AGENT_INVOCATIONS_PER_CHILD,
        );
      }
      assertChildAgentCapacity(open, {
        childConversationId: input.childConversationId,
        parentConversationId: input.parentConversationId,
      });
      const invocation = await insertAgentInvocation(
        {
          actor: input.actor,
          agentName: latest.agentName,
          agentType: latest.agentType,
          childConversationId: input.childConversationId,
          credentialContext: input.credentialContext,
          destination: input.destination,
          input: input.input,
          invocationId,
          parentConversationId: input.parentConversationId,
          parentToolCallId: input.parentToolCallId,
          reasoningLevel: latest.reasoningLevel,
        },
        nowMs,
      );
      if (!invocation) {
        throw new Error(`Agent invocation creation raced for ${invocationId}`);
      }
      return { invocation, queued: openCount > 0 };
    },
  );
}
