import { createHash } from "node:crypto";
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  inArray,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { getConversationStore, getSqlExecutor } from "@/chat/db";
import { juniorAgentBindings, juniorAgentInvocations } from "@/db/schema";
import {
  agentBindingSchema,
  agentInvocationSchema,
  createAgentInvocationSchema,
  type AgentBinding,
  type AgentInvocation,
  type AgentInvocationStatus,
  type CreateAgentInvocationInput,
  type TerminalAgentInvocation,
} from "./types";
import {
  AgentInvocationLimitError,
  AgentMessageQueueFullError,
  AgentNameInUseError,
} from "./errors";

const CREATE_LOCK_PREFIX = "junior:agent_invocation:create";

/**
 * Return the SQL lock that one parent Conversation takes to start, message,
 * or stop its child agents.
 */
export function getChildAgentLockName(parentConversationId: string): string {
  return `${CREATE_LOCK_PREFIX}:${parentConversationId}`;
}
/** Cap concurrent non-terminal children one parent can keep in flight. */
export const MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT = 8;
/**
 * Cap the non-terminal agent invocations of one child, including the one that
 * runs. Each message to a busy child queues one more.
 */
export const MAX_OPEN_AGENT_INVOCATIONS_PER_CHILD = 4;
const TERMINAL_AGENT_INVOCATION_STATUSES = [
  "blocked",
  "completed",
  "failed",
  "stopped",
] as const satisfies readonly AgentInvocationStatus[];
/** Statuses of an agent invocation that has not finished. */
export const NON_TERMINAL_AGENT_INVOCATION_STATUSES = [
  "pending",
  "running",
  "paused",
] as const satisfies readonly AgentInvocationStatus[];

function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}:${digest}`;
}

/** Return the stable identity for one retry-safe delegated task. */
export function getAgentInvocationId(
  parentConversationId: string,
  idempotencyKey: string,
): string {
  return stableId("agent-invocation", parentConversationId, idempotencyKey);
}

/** Return the stable child identity for one invocation without a named binding. */
export function getUnnamedAgentConversationId(invocationId: string): string {
  return stableId("agent", invocationId);
}

/** Return the stable child identity for one named binding. */
export function getNamedAgentConversationId(
  parentConversationId: string,
  name: string,
): string {
  return stableId("agent", parentConversationId, name);
}

/**
 * Return the stable identity of the agent invocation that gives one child
 * agent result to the child Conversation that started that child agent.
 */
export function getAgentInvocationIdForResult(
  resultInvocationId: string,
): string {
  return stableId("agent-invocation", "result", resultInvocationId);
}

/**
 * Return the stable identity of the agent invocation that gives one message
 * from a child agent to the child Conversation that started that child agent.
 */
export function getAgentInvocationIdForMessage(messageId: string): string {
  return stableId("agent-invocation", "message", messageId);
}

/**
 * Return the stable identity of the agent invocation that gives one batch of
 * watch events to a child Conversation. The first message of the batch names
 * it.
 */
export function getAgentInvocationIdForEvents(messageId: string): string {
  return stableId("agent-invocation", "events", messageId);
}

/** Return the stable turn identity advanced by one agent invocation. */
export function getAgentInvocationTurnId(invocationId: string): string {
  return `agent-invocation:${invocationId}`;
}

/** Return the stable mailbox identity for one agent invocation. */
export function getAgentInvocationMessageId(invocationId: string): string {
  return `agent-invocation:${invocationId}:input`;
}

const RESULT_MESSAGE_PREFIX = "agent-invocation:";
const RESULT_MESSAGE_SUFFIX = ":result";

/** Return the stable parent mailbox identity for one terminal result. */
export function getAgentInvocationResultMessageId(
  invocationId: string,
): string {
  return `${RESULT_MESSAGE_PREFIX}${invocationId}${RESULT_MESSAGE_SUFFIX}`;
}

/** Read the invocation identity from one parent result mailbox identity. */
export function parseAgentInvocationResultMessageId(
  messageId: string,
): string | undefined {
  if (
    !messageId.startsWith(RESULT_MESSAGE_PREFIX) ||
    !messageId.endsWith(RESULT_MESSAGE_SUFFIX)
  ) {
    return undefined;
  }
  const invocationId = messageId.slice(
    RESULT_MESSAGE_PREFIX.length,
    -RESULT_MESSAGE_SUFFIX.length,
  );
  return invocationId || undefined;
}

function bindingFromRow(
  row: typeof juniorAgentBindings.$inferSelect,
): AgentBinding {
  return agentBindingSchema.parse({
    childConversationId: row.childConversationId,
    name: row.name,
    parentConversationId: row.parentConversationId,
  });
}

/** Parse one agent invocation row. */
export function invocationFromRow(
  row: typeof juniorAgentInvocations.$inferSelect,
): AgentInvocation {
  return agentInvocationSchema.parse({
    actor: row.actor,
    ...(row.agentName ? { agentName: row.agentName } : undefined),
    childConversationId: row.childConversationId,
    createdAtMs: row.createdAt.getTime(),
    ...(row.credentialContext
      ? { credentialContext: row.credentialContext }
      : undefined),
    destination: row.destination,
    ...(row.errorMessage !== null
      ? { errorMessage: row.errorMessage }
      : undefined),
    input: row.input,
    invocationId: row.invocationId,
    mailboxStatus: row.mailboxStatus,
    parentConversationId: row.parentConversationId,
    ...(row.parentMailboxStatus
      ? { parentMailboxStatus: row.parentMailboxStatus }
      : undefined),
    ...(row.parentToolCallId
      ? { parentToolCallId: row.parentToolCallId }
      : undefined),
    ...(row.agentType ? { agentType: row.agentType } : undefined),
    ...(row.modelProfile ? { modelProfile: row.modelProfile } : undefined),
    ...(row.reasoningLevel
      ? { reasoningLevel: row.reasoningLevel }
      : undefined),
    ...(row.result !== null ? { result: row.result } : undefined),
    source: row.source,
    status: row.status,
    ...(row.terminalAt
      ? { terminalAtMs: row.terminalAt.getTime() }
      : undefined),
    ...(row.title ? { title: row.title } : undefined),
    updatedAtMs: row.updatedAt.getTime(),
  });
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
    invocation.modelProfile === input.modelProfile &&
    invocation.reasoningLevel === input.reasoningLevel &&
    JSON.stringify(invocation.actor) === JSON.stringify(input.actor) &&
    JSON.stringify(invocation.credentialContext) ===
      JSON.stringify(input.credentialContext) &&
    JSON.stringify(invocation.destination) === JSON.stringify(input.destination)
  );
}

/** Read one named child binding in its parent-agent scope. */
async function getAgentBinding(args: {
  name: string;
  parentConversationId: string;
}): Promise<AgentBinding | undefined> {
  const rows = await getSqlExecutor()
    .db()
    .select()
    .from(juniorAgentBindings)
    .where(
      and(
        eq(juniorAgentBindings.parentConversationId, args.parentConversationId),
        eq(juniorAgentBindings.name, args.name),
      ),
    );
  return rows[0] ? bindingFromRow(rows[0]) : undefined;
}

/** Read one durable agent invocation. */
export async function getAgentInvocation(
  invocationId: string,
): Promise<AgentInvocation | undefined> {
  const rows = await getSqlExecutor()
    .db()
    .select()
    .from(juniorAgentInvocations)
    .where(eq(juniorAgentInvocations.invocationId, invocationId));
  return rows[0] ? invocationFromRow(rows[0]) : undefined;
}

/** Resolve the single invocation that may resume for one child conversation. */
export async function getActiveAgentInvocationForConversation(
  childConversationId: string,
): Promise<AgentInvocation | undefined> {
  const rows = await getSqlExecutor()
    .db()
    .select()
    .from(juniorAgentInvocations)
    .where(
      and(
        eq(juniorAgentInvocations.childConversationId, childConversationId),
        inArray(juniorAgentInvocations.status, ["running", "paused"]),
      ),
    )
    .orderBy(asc(juniorAgentInvocations.createdAt))
    .limit(2);
  if (rows.length > 1) {
    throw new Error(
      `Child conversation ${childConversationId} has multiple active agent invocations`,
    );
  }
  return rows[0] ? invocationFromRow(rows[0]) : undefined;
}

/** Read the newest agent invocation of one child Conversation. */
export async function getLatestAgentInvocationForConversation(
  childConversationId: string,
): Promise<AgentInvocation | undefined> {
  const rows = await getSqlExecutor()
    .db()
    .select()
    .from(juniorAgentInvocations)
    .where(eq(juniorAgentInvocations.childConversationId, childConversationId))
    .orderBy(desc(juniorAgentInvocations.createdAt))
    .limit(1);
  return rows[0] ? invocationFromRow(rows[0]) : undefined;
}

/**
 * Read the name and the newest task title of one child Conversation, for
 * labels. Agent invocations that give a nested result to the child have no
 * title, so an agent invocation with a title comes first.
 */
export async function getChildAgentLabel(
  childConversationId: string,
): Promise<{ agentName: string | null; title: string | null } | undefined> {
  const [row] = await getSqlExecutor()
    .db()
    .select({
      agentName: juniorAgentInvocations.agentName,
      title: juniorAgentInvocations.title,
    })
    .from(juniorAgentInvocations)
    .where(eq(juniorAgentInvocations.childConversationId, childConversationId))
    .orderBy(
      sql`${juniorAgentInvocations.title} is null`,
      desc(juniorAgentInvocations.createdAt),
    )
    .limit(1);
  return row;
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
 * Count the child agents of one parent that have open work. Messages queued
 * for a busy child do not count again.
 */
async function countActiveChildAgentsForParent(
  parentConversationId: string,
): Promise<number> {
  const rows = await getSqlExecutor()
    .db()
    .select({
      value: countDistinct(juniorAgentInvocations.childConversationId),
    })
    .from(juniorAgentInvocations)
    .where(
      and(
        eq(juniorAgentInvocations.parentConversationId, parentConversationId),
        inArray(
          juniorAgentInvocations.status,
          NON_TERMINAL_AGENT_INVOCATION_STATUSES,
        ),
      ),
    );
  return rows[0]?.value ?? 0;
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

    const activeCount = await countActiveChildAgentsForParent(
      input.parentConversationId,
    );
    if (activeCount >= MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT) {
      throw new AgentInvocationLimitError(
        MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT,
      );
    }

    await getConversationStore().createChild({
      childConversationId,
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
        modelProfile: input.modelProfile ?? null,
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
      modelProfile: args.latest.modelProfile ?? null,
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

/** Find a direct child agent of one parent by name or child Conversation id. */
export async function findChildAgentConversationId(args: {
  parentConversationId: string;
  target: string;
}): Promise<string | undefined> {
  const binding = await getAgentBinding({
    name: args.target,
    parentConversationId: args.parentConversationId,
  });
  if (binding) {
    return binding.childConversationId;
  }
  const rows = await getSqlExecutor()
    .db()
    .select({ childConversationId: juniorAgentInvocations.childConversationId })
    .from(juniorAgentInvocations)
    .where(
      and(
        eq(
          juniorAgentInvocations.parentConversationId,
          args.parentConversationId,
        ),
        eq(juniorAgentInvocations.childConversationId, args.target),
      ),
    )
    .limit(1);
  return rows[0]?.childConversationId;
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
      // A busy child is already counted. An idle child becomes active.
      if (
        openCount === 0 &&
        (await countActiveChildAgentsForParent(input.parentConversationId)) >=
          MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT
      ) {
        throw new AgentInvocationLimitError(
          MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT,
        );
      }
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
          modelProfile: latest.modelProfile ?? null,
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

/**
 * Return whether a child Conversation has work that will start another agent
 * invocation on it: another open agent invocation, an open child agent, or a
 * sent child agent result that no agent invocation has received yet.
 */
async function hasOpenChildWork(invocation: AgentInvocation): Promise<boolean> {
  const db = getSqlExecutor().db();
  const conversationId = invocation.childConversationId;
  const open = await db
    .select({ invocationId: juniorAgentInvocations.invocationId })
    .from(juniorAgentInvocations)
    .where(
      and(
        or(
          eq(juniorAgentInvocations.childConversationId, conversationId),
          eq(juniorAgentInvocations.parentConversationId, conversationId),
        ),
        ne(juniorAgentInvocations.invocationId, invocation.invocationId),
        inArray(
          juniorAgentInvocations.status,
          NON_TERMINAL_AGENT_INVOCATION_STATUSES,
        ),
      ),
    )
    .limit(1);
  if (open.length > 0) {
    return true;
  }
  // A `replaced` child result is never sent. A later agent invocation of
  // that child agent sends its report instead.
  const sent = await db
    .select({ invocationId: juniorAgentInvocations.invocationId })
    .from(juniorAgentInvocations)
    .where(
      and(
        eq(juniorAgentInvocations.parentConversationId, conversationId),
        inArray(juniorAgentInvocations.parentMailboxStatus, [
          "pending",
          "appended",
        ]),
      ),
    );
  if (sent.length === 0) {
    return false;
  }
  const received = await db
    .select({ invocationId: juniorAgentInvocations.invocationId })
    .from(juniorAgentInvocations)
    .where(
      inArray(
        juniorAgentInvocations.invocationId,
        sent.map((row) => getAgentInvocationIdForResult(row.invocationId)),
      ),
    );
  return received.length < sent.length;
}

/** List bounded invocation records whose mailbox append still needs repair. */
export async function listPendingAgentInvocationMailboxAppends(
  limit = 100,
): Promise<AgentInvocation[]> {
  const rows = await getSqlExecutor()
    .db()
    .select()
    .from(juniorAgentInvocations)
    .where(
      and(
        eq(juniorAgentInvocations.mailboxStatus, "pending"),
        inArray(
          juniorAgentInvocations.status,
          NON_TERMINAL_AGENT_INVOCATION_STATUSES,
        ),
      ),
    )
    .orderBy(asc(juniorAgentInvocations.createdAt))
    .limit(limit);
  return rows.map(invocationFromRow);
}

/** List terminal agent invocation results that still need a parent mailbox append. */
export async function listPendingAgentInvocationResults(
  limit = 100,
): Promise<TerminalAgentInvocation[]> {
  const rows = await getSqlExecutor()
    .db()
    .select()
    .from(juniorAgentInvocations)
    .where(eq(juniorAgentInvocations.parentMailboxStatus, "pending"))
    .orderBy(asc(juniorAgentInvocations.terminalAt))
    .limit(limit);
  return rows.map(invocationFromRow).filter(isTerminalAgentInvocation);
}

/**
 * Send a `replaced` result to the parent now. A stop ended the open work of
 * the child, so no later agent invocation sends the report.
 */
export async function reportReplacedAgentInvocation(
  invocationId: string,
  nowMs = Date.now(),
): Promise<AgentInvocation | undefined> {
  await getSqlExecutor()
    .db()
    .update(juniorAgentInvocations)
    .set({ parentMailboxStatus: "pending", updatedAt: new Date(nowMs) })
    .where(
      and(
        eq(juniorAgentInvocations.invocationId, invocationId),
        eq(juniorAgentInvocations.parentMailboxStatus, "replaced"),
      ),
    );
  return await getAgentInvocation(invocationId);
}

/** Record that one terminal result is in its parent mailbox. */
export async function markAgentInvocationParentMailboxAppended(
  invocationId: string,
  nowMs = Date.now(),
): Promise<void> {
  await getSqlExecutor()
    .db()
    .update(juniorAgentInvocations)
    .set({ parentMailboxStatus: "appended", updatedAt: new Date(nowMs) })
    .where(
      and(
        eq(juniorAgentInvocations.invocationId, invocationId),
        eq(juniorAgentInvocations.parentMailboxStatus, "pending"),
      ),
    );
}

/** Record that the invocation's idempotent mailbox append completed. */
export async function markAgentInvocationMailboxAppended(
  invocationId: string,
  nowMs = Date.now(),
): Promise<void> {
  await getSqlExecutor()
    .db()
    .update(juniorAgentInvocations)
    .set({ mailboxStatus: "appended", updatedAt: new Date(nowMs) })
    .where(eq(juniorAgentInvocations.invocationId, invocationId));
}

/** Mark one non-terminal invocation as actively executing. */
export async function markAgentInvocationRunning(
  invocationId: string,
  nowMs = Date.now(),
): Promise<AgentInvocation | undefined> {
  await getSqlExecutor()
    .db()
    .update(juniorAgentInvocations)
    .set({ status: "running", updatedAt: new Date(nowMs) })
    .where(
      and(
        eq(juniorAgentInvocations.invocationId, invocationId),
        inArray(
          juniorAgentInvocations.status,
          NON_TERMINAL_AGENT_INVOCATION_STATUSES,
        ),
      ),
    );
  return await getAgentInvocation(invocationId);
}

/** Mark one invocation as waiting for another shared execution slice. */
export async function markAgentInvocationPaused(
  invocationId: string,
  nowMs = Date.now(),
): Promise<void> {
  await getSqlExecutor()
    .db()
    .update(juniorAgentInvocations)
    .set({ status: "paused", updatedAt: new Date(nowMs) })
    .where(
      and(
        eq(juniorAgentInvocations.invocationId, invocationId),
        inArray(
          juniorAgentInvocations.status,
          NON_TERMINAL_AGENT_INVOCATION_STATUSES,
        ),
      ),
    );
}

/**
 * Persist one terminal invocation result without overwriting an earlier
 * result. The same write marks the result for the parent mailbox. If the
 * child still has open work, the result is `replaced`: the parent gets one
 * report, from the agent invocation that finishes the child's work.
 */
export async function completeAgentInvocation(
  args:
    | {
        invocationId: string;
        result: string;
        status: "completed";
        nowMs?: number;
      }
    | {
        errorMessage: string;
        invocationId: string;
        status: "blocked" | "failed" | "stopped";
        nowMs?: number;
      },
): Promise<AgentInvocation | undefined> {
  const nowMs = args.nowMs ?? Date.now();
  const current = await getAgentInvocation(args.invocationId);
  if (!current || isTerminalAgentInvocation(current)) {
    return current;
  }
  // Open child work only moves forward, so a read before the write is safe:
  // each `replaced` result has open work that starts a later invocation. A
  // stop is always reported, because the stop also stops that open work.
  const parentMailboxStatus =
    args.status !== "stopped" && (await hasOpenChildWork(current))
      ? "replaced"
      : "pending";
  await getSqlExecutor()
    .db()
    .update(juniorAgentInvocations)
    .set({
      status: args.status,
      result: args.status === "completed" ? args.result : null,
      errorMessage: args.status === "completed" ? null : args.errorMessage,
      parentMailboxStatus,
      terminalAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    })
    .where(
      and(
        eq(juniorAgentInvocations.invocationId, args.invocationId),
        inArray(
          juniorAgentInvocations.status,
          NON_TERMINAL_AGENT_INVOCATION_STATUSES,
        ),
      ),
    );
  return await getAgentInvocation(args.invocationId);
}

/**
 * End a pending agent invocation whose input the running agent invocation of
 * the same child read as a steering message. The running agent invocation
 * reports for both, so this one is never sent to the parent.
 */
export async function markAgentInvocationSteered(
  invocationId: string,
  nowMs = Date.now(),
): Promise<AgentInvocation | undefined> {
  await getSqlExecutor()
    .db()
    .update(juniorAgentInvocations)
    .set({
      status: "completed",
      result: "",
      parentMailboxStatus: "steered",
      terminalAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    })
    .where(
      and(
        eq(juniorAgentInvocations.invocationId, invocationId),
        eq(juniorAgentInvocations.status, "pending"),
      ),
    );
  return await getAgentInvocation(invocationId);
}

/** Return whether an agent invocation has finished. */
export function isTerminalAgentInvocation(
  invocation: AgentInvocation,
): invocation is TerminalAgentInvocation {
  return TERMINAL_AGENT_INVOCATION_STATUSES.includes(
    invocation.status as (typeof TERMINAL_AGENT_INVOCATION_STATUSES)[number],
  );
}
