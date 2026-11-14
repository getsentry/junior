import { getConversationStoppedAtMs } from "@/chat/conversations/session-stop";
import { getConversationStore, getSqlExecutor } from "@/chat/db";
import { eq } from "drizzle-orm";
import {
  juniorAgentBindings,
  juniorAgentInvocations,
  juniorConversations,
} from "@/db/schema";
import { nextDetailVersion } from "@/chat/conversations/sql/detail-version";
import { getAgentBinding } from "./bindings";
import { readChildConversationSender } from "./child-input";
import {
  countOpenParentMessages,
  listOpenChildAgentsWithoutAgentInvocations,
} from "./list";
import {
  agentConfigSchema,
  readAgentConfig,
  type AgentConfig,
} from "@/chat/conversations/agent-config";
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
      // A child that no Agent invocation names counts its open parent
      // messages instead.
      const openCount =
        open.filter(
          (row) => row.childConversationId === input.childConversationId,
        ).length +
        (latest ? 0 : await countOpenParentMessages(input.childConversationId));
      if (openCount >= MAX_OPEN_AGENT_INVOCATIONS_PER_CHILD) {
        throw new AgentMessageQueueFullError(
          MAX_OPEN_AGENT_INVOCATIONS_PER_CHILD,
        );
      }
      await assertChildAgentCapacity(open, {
        childConversationId: input.childConversationId,
        parentConversationId: input.parentConversationId,
      });
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
      return { invocation, queued: openCount > 0 };
    },
  );
}

/** A new child agent that gets its work as parent messages, with no row. */
type NewChildWithoutAgentInvocation = {
  agentConfig: AgentConfig;
  agentName?: string;
  idempotencyKey: string;
  kind: "task" | "thread";
  parentConversationId: string;
  title?: string;
};

/** Return the Conversation id that a new child agent gets. */
export function newChildAgentConversationId(
  input: Pick<
    NewChildWithoutAgentInvocation,
    "agentName" | "idempotencyKey" | "parentConversationId"
  >,
): string {
  return input.agentName
    ? getNamedAgentConversationId(input.parentConversationId, input.agentName)
    : getUnnamedAgentConversationId(
        getAgentInvocationId(input.parentConversationId, input.idempotencyKey),
      );
}

async function assertCanCreateChild(
  input: NewChildWithoutAgentInvocation,
  childConversationId: string,
): Promise<void> {
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
  await assertChildAgentCapacity(open, {
    childConversationId,
    parentConversationId: input.parentConversationId,
  });
}

/**
 * Throw when the parent cannot start this child agent now, with the same
 * checks that `createChildWithoutAgentInvocation` runs. Call it before a
 * side effect that the child needs, such as a provider channel, so that a
 * refused spawn leaves nothing behind.
 */
export async function assertCanCreateChildWithoutAgentInvocation(
  input: NewChildWithoutAgentInvocation,
): Promise<void> {
  const childConversationId = newChildAgentConversationId(input);
  await getSqlExecutor().withLock(
    getChildAgentLockName(input.parentConversationId),
    async () => {
      if (
        await getConversationStore().get({
          conversationId: childConversationId,
        })
      )
        return;
      await assertCanCreateChild(input, childConversationId);
    },
  );
}

/**
 * Create or replay one child agent that no Agent invocation names. Its agent
 * config marks it, and its work arrives as parent messages
 * (`appendParentMessage`). Returns its Conversation id.
 */
export async function createChildWithoutAgentInvocation(
  input: NewChildWithoutAgentInvocation,
  nowMs = Date.now(),
): Promise<string> {
  const childConversationId = newChildAgentConversationId(input);
  return await getSqlExecutor().withLock(
    getChildAgentLockName(input.parentConversationId),
    async () => {
      const existing = await getConversationStore().get({
        conversationId: childConversationId,
      });
      if (existing) {
        // The id derives from the parent, so only the kind can differ.
        if (existing.kind !== input.kind) {
          throw new Error(
            `Child agent ${childConversationId} was reused with different input`,
          );
        }
        return childConversationId;
      }
      await assertCanCreateChild(input, childConversationId);
      await getConversationStore().createChild({
        childConversationId,
        kind: input.kind,
        parentConversationId: input.parentConversationId,
        nowMs,
        source: "internal",
        ...(input.title ? { title: input.title } : undefined),
      });
      await getSqlExecutor()
        .db()
        .update(juniorConversations)
        .set({
          agentConfig: agentConfigSchema.parse(input.agentConfig),
          detailVersion: nextDetailVersion,
        })
        .where(eq(juniorConversations.conversationId, childConversationId));
      if (input.agentName) {
        await getSqlExecutor().db().insert(juniorAgentBindings).values({
          childConversationId,
          name: input.agentName,
          parentConversationId: input.parentConversationId,
        });
      }
      return childConversationId;
    },
  );
}
