import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, inArray, ne, or } from "drizzle-orm";
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
import { AgentInvocationBusyError, AgentInvocationLimitError } from "./errors";

const CREATE_LOCK_PREFIX = "junior:agent_invocation:create";
/** Cap concurrent non-terminal children one parent can keep in flight. */
export const MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT = 8;
const TERMINAL_AGENT_INVOCATION_STATUSES = [
  "blocked",
  "completed",
  "failed",
] as const satisfies readonly AgentInvocationStatus[];
const NON_TERMINAL_AGENT_INVOCATION_STATUSES = [
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

/** Return the stable turn identity advanced by one agent invocation. */
export function getAgentInvocationTurnId(invocationId: string): string {
  return `agent-invocation:${invocationId}`;
}

/** Return the stable mailbox identity for one agent invocation. */
export function getAgentInvocationMessageId(invocationId: string): string {
  return `agent-invocation:${invocationId}:input`;
}

/** Return the stable parent mailbox identity for one terminal result. */
export function getAgentInvocationResultMessageId(
  invocationId: string,
): string {
  return `agent-invocation:${invocationId}:result`;
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

function invocationFromRow(
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
    ...(row.reasoningLevel
      ? { reasoningLevel: row.reasoningLevel }
      : undefined),
    ...(row.result !== null ? { result: row.result } : undefined),
    source: row.source,
    status: row.status,
    ...(row.terminalAt
      ? { terminalAtMs: row.terminalAt.getTime() }
      : undefined),
    updatedAtMs: row.updatedAt.getTime(),
  });
}

/** Require every durable creation input to match before replaying one key. */
function sameCreateInput(
  invocation: AgentInvocation,
  input: ReturnType<typeof createAgentInvocationSchema.parse>,
): boolean {
  return (
    invocation.parentConversationId === input.parentConversationId &&
    invocation.agentName === input.agentName &&
    invocation.input === input.input &&
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

async function countNonTerminalAgentInvocationsForParent(
  parentConversationId: string,
): Promise<number> {
  const rows = await getSqlExecutor()
    .db()
    .select({ value: count() })
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
 * Create or replay one invocation, reusing named child conversations and
 * keeping unnamed child identities scoped to the invocation.
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
  const lockName = `${CREATE_LOCK_PREFIX}:${input.parentConversationId}`;
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

    const activeCount = await countNonTerminalAgentInvocationsForParent(
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

    if (input.agentName) {
      await getSqlExecutor()
        .db()
        .insert(juniorAgentBindings)
        .values({
          childConversationId,
          name: input.agentName,
          parentConversationId: input.parentConversationId,
        })
        .onConflictDoNothing();
      const binding = await getAgentBinding({
        name: input.agentName,
        parentConversationId: input.parentConversationId,
      });
      if (!binding || binding.childConversationId !== childConversationId) {
        throw new Error(
          `Named agent binding did not resolve to ${childConversationId}`,
        );
      }
      if (
        await getNonTerminalAgentInvocationForConversation(childConversationId)
      ) {
        throw new AgentInvocationBusyError(input.agentName);
      }
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
        actor: input.actor,
        credentialContext: input.credentialContext ?? null,
        source: { kind: "agent_invocation" },
        destination: input.destination,
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
 * Create or replay the agent invocation that gives one child agent result to
 * the child Conversation that started it. It continues that Conversation for
 * the same parent, Actor, and credentials as `latest`. It skips the busy and
 * active-count checks because it continues work that already passed them.
 */
export async function createAgentInvocationForResult(
  args: {
    input: string;
    latest: AgentInvocation;
    resultInvocationId: string;
  },
  nowMs = Date.now(),
): Promise<AgentInvocation> {
  const invocationId = getAgentInvocationIdForResult(args.resultInvocationId);
  await getSqlExecutor()
    .db()
    .insert(juniorAgentInvocations)
    .values({
      invocationId,
      parentConversationId: args.latest.parentConversationId,
      childConversationId: args.latest.childConversationId,
      agentName: args.latest.agentName ?? null,
      input: args.input,
      actor: args.latest.actor,
      credentialContext: args.latest.credentialContext ?? null,
      source: { kind: "agent_invocation" },
      destination: args.latest.destination,
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
    .where(eq(juniorAgentInvocations.mailboxStatus, "pending"))
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
        status: "blocked" | "failed";
        nowMs?: number;
      },
): Promise<AgentInvocation | undefined> {
  const nowMs = args.nowMs ?? Date.now();
  const current = await getAgentInvocation(args.invocationId);
  if (!current || isTerminalAgentInvocation(current)) {
    return current;
  }
  // Open child work only moves forward, so a read before the write is safe:
  // each `replaced` result has open work that starts a later invocation.
  const parentMailboxStatus = (await hasOpenChildWork(current))
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

/** Return whether an agent invocation has finished. */
export function isTerminalAgentInvocation(
  invocation: AgentInvocation,
): invocation is TerminalAgentInvocation {
  return TERMINAL_AGENT_INVOCATION_STATUSES.includes(
    invocation.status as (typeof TERMINAL_AGENT_INVOCATION_STATUSES)[number],
  );
}
