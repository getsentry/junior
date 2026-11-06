import { and, asc, count, eq, inArray, lt } from "drizzle-orm";
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
  invocationFromRow,
  NON_TERMINAL_AGENT_INVOCATION_STATUSES,
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
export const MAX_OPEN_AGENT_INVOCATIONS_PER_CHILD = 4;

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
    invocation.reasoningLevel === input.reasoningLevel &&
    JSON.stringify(invocation.actor) === JSON.stringify(input.actor) &&
    JSON.stringify(invocation.credentialContext) ===
      JSON.stringify(input.credentialContext) &&
    JSON.stringify(invocation.destination) === JSON.stringify(input.destination)
  );
}

async function getNonTerminalAgentInvocationForConversation(
  childConversationId: string,
): Promise<AgentInvocation | undefined> {
  const rows = await getSqlExecutor()
    .db()
    .select()
    .from(juniorAgentInvocations)
    .where(
      and(
        eq(juniorAgentInvocations.childConversationId, childConversationId),
        inArray(
          juniorAgentInvocations.status,
          NON_TERMINAL_AGENT_INVOCATION_STATUSES,
        ),
      ),
    )
    .orderBy(asc(juniorAgentInvocations.createdAt))
    .limit(1);
  return rows[0] ? invocationFromRow(rows[0]) : undefined;
}

async function countNonTerminalAgentInvocationsForChild(
  childConversationId: string,
): Promise<number> {
  const rows = await getSqlExecutor()
    .db()
    .select({ value: count() })
    .from(juniorAgentInvocations)
    .where(
      and(
        eq(juniorAgentInvocations.childConversationId, childConversationId),
        inArray(
          juniorAgentInvocations.status,
          NON_TERMINAL_AGENT_INVOCATION_STATUSES,
        ),
      ),
    );
  return rows[0]?.value ?? 0;
}

/**
 * A child agent can only start or give work to child agents while it has
 * open work. A stopped child has none. A root Conversation has no agent
 * invocation, so it always passes.
 */
async function assertCanGiveChildWork(
  parentConversationId: string,
): Promise<void> {
  if (
    (await getLatestAgentInvocationForConversation(parentConversationId)) &&
    !(await getNonTerminalAgentInvocationForConversation(parentConversationId))
  ) {
    throw new Error(
      `Agent conversation ${parentConversationId} has no open work and cannot give work to child agents`,
    );
  }
}

/**
 * Throw when giving work to one child agent would put its parent over
 * `MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT`. A child agent is active while it
 * has open work, so a busy child already counts and messages queued for it
 * do not count again. A new or idle child becomes active. This is the only
 * place the rule for which child agents count lives. Callers hold the
 * parent's child agent lock.
 */
async function assertChildAgentCapacity(args: {
  childConversationId: string;
  parentConversationId: string;
}): Promise<void> {
  const active = await getSqlExecutor()
    .db()
    .selectDistinct({
      childConversationId: juniorAgentInvocations.childConversationId,
    })
    .from(juniorAgentInvocations)
    .where(
      and(
        eq(
          juniorAgentInvocations.parentConversationId,
          args.parentConversationId,
        ),
        inArray(
          juniorAgentInvocations.status,
          NON_TERMINAL_AGENT_INVOCATION_STATUSES,
        ),
      ),
    );
  if (
    active.some((row) => row.childConversationId === args.childConversationId)
  ) {
    return;
  }
  if (active.length >= MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT) {
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
      if (!sameCreateInput(existing, input)) {
        throw new Error(
          `Agent invocation idempotency key was reused with different input for ${invocationId}`,
        );
      }
      return existing;
    }
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

    await assertChildAgentCapacity({
      childConversationId,
      parentConversationId: input.parentConversationId,
    });

    await getConversationStore().createChild({
      childConversationId,
      kind: "task",
      parentConversationId: input.parentConversationId,
      nowMs,
      source: "internal",
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

    await getSqlExecutor()
      .db()
      .insert(juniorAgentInvocations)
      .values({
        invocationId,
        parentConversationId: input.parentConversationId,
        childConversationId,
        agentName: input.agentName ?? null,
        input: input.input,
        title: input.title ?? null,
        actor: input.actor,
        credentialContext: input.credentialContext ?? null,
        source: { kind: "agent_invocation" },
        destination: input.destination,
        agentType: input.agentType ?? null,
        reasoningLevel: input.reasoningLevel ?? null,
        parentToolCallId: input.parentToolCallId ?? null,
        status: "pending",
        mailboxStatus: "pending",
        createdAt: new Date(nowMs),
        updatedAt: new Date(nowMs),
        terminalAt: null,
      })
      .onConflictDoNothing();
    const invocation = await getAgentInvocation(invocationId);
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
    /** Actor, credentials, and Source for watch events. */
    runAs?: Pick<AgentInvocation, "actor" | "credentialContext" | "source">;
  },
  nowMs = Date.now(),
): Promise<AgentInvocation> {
  const { invocationId } = args;
  await getSqlExecutor()
    .db()
    .insert(juniorAgentInvocations)
    .values({
      invocationId,
      parentConversationId: args.latest.parentConversationId,
      childConversationId: args.latest.childConversationId,
      agentName: args.latest.agentName ?? null,
      input: args.input,
      actor: (args.runAs ?? args.latest).actor,
      credentialContext: (args.runAs ?? args.latest).credentialContext ?? null,
      source: args.runAs?.source ?? { kind: "agent_invocation" },
      destination: args.latest.destination,
      agentType: args.latest.agentType ?? null,
      reasoningLevel: args.latest.reasoningLevel ?? null,
      status: "pending",
      mailboxStatus: "pending",
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
      terminalAt: null,
    })
    .onConflictDoNothing();
  const invocation = await getAgentInvocation(invocationId);
  if (
    !invocation ||
    invocation.childConversationId !== args.latest.childConversationId
  ) {
    throw new Error(`Agent invocation creation raced for ${invocationId}`);
  }
  return invocation;
}

/**
 * Return whether a pending agent invocation still waits for older open work
 * on its child.
 */
async function isQueuedBehindOpenWork(
  invocation: AgentInvocation,
): Promise<boolean> {
  if (invocation.status !== "pending") {
    return false;
  }
  const rows = await getSqlExecutor()
    .db()
    .select({ invocationId: juniorAgentInvocations.invocationId })
    .from(juniorAgentInvocations)
    .where(
      and(
        eq(
          juniorAgentInvocations.childConversationId,
          invocation.childConversationId,
        ),
        lt(juniorAgentInvocations.createdAt, new Date(invocation.createdAtMs)),
        inArray(
          juniorAgentInvocations.status,
          NON_TERMINAL_AGENT_INVOCATION_STATUSES,
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
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
        return {
          invocation: existing,
          queued: await isQueuedBehindOpenWork(existing),
        };
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
      await assertCanGiveChildWork(input.parentConversationId);
      const openCount = await countNonTerminalAgentInvocationsForChild(
        input.childConversationId,
      );
      if (openCount >= MAX_OPEN_AGENT_INVOCATIONS_PER_CHILD) {
        throw new AgentMessageQueueFullError(
          MAX_OPEN_AGENT_INVOCATIONS_PER_CHILD,
        );
      }
      await assertChildAgentCapacity({
        childConversationId: input.childConversationId,
        parentConversationId: input.parentConversationId,
      });
      await getSqlExecutor()
        .db()
        .insert(juniorAgentInvocations)
        .values({
          invocationId,
          parentConversationId: input.parentConversationId,
          childConversationId: input.childConversationId,
          agentName: latest.agentName ?? null,
          input: input.input,
          title: null,
          actor: input.actor,
          credentialContext: input.credentialContext ?? null,
          source: { kind: "agent_invocation" },
          destination: input.destination,
          agentType: latest.agentType ?? null,
          reasoningLevel: latest.reasoningLevel ?? null,
          parentToolCallId: input.parentToolCallId,
          status: "pending",
          mailboxStatus: "pending",
          createdAt: new Date(nowMs),
          updatedAt: new Date(nowMs),
          terminalAt: null,
        })
        .onConflictDoNothing();
      const invocation = await getAgentInvocation(invocationId);
      if (!invocation) {
        throw new Error(`Agent invocation creation raced for ${invocationId}`);
      }
      return { invocation, queued: openCount > 0 };
    },
  );
}
