import { createHash } from "node:crypto";
import { and, asc, count, eq, inArray } from "drizzle-orm";
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
  "awaiting_resume",
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

/** Return the stable turn identity advanced by one agent invocation. */
export function getAgentInvocationTurnId(invocationId: string): string {
  return `agent-invocation:${invocationId}`;
}

/** Return the stable mailbox identity for one agent invocation. */
export function getAgentInvocationMessageId(invocationId: string): string {
  return `agent-invocation:${invocationId}:input`;
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
    JSON.stringify(invocation.destination) ===
      JSON.stringify(input.destination) &&
    JSON.stringify(invocation.source) === JSON.stringify(input.source)
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
        inArray(juniorAgentInvocations.status, ["running", "awaiting_resume"]),
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
        source: input.source,
        destination: input.destination,
        reasoningLevel: input.reasoningLevel ?? null,
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
export async function markAgentInvocationAwaitingResume(
  invocationId: string,
  nowMs = Date.now(),
): Promise<void> {
  await getSqlExecutor()
    .db()
    .update(juniorAgentInvocations)
    .set({ status: "awaiting_resume", updatedAt: new Date(nowMs) })
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

/** Persist one terminal invocation result without overwriting an earlier result. */
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
  await getSqlExecutor()
    .db()
    .update(juniorAgentInvocations)
    .set({
      status: args.status,
      result: args.status === "completed" ? args.result : null,
      errorMessage: args.status === "completed" ? null : args.errorMessage,
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
): invocation is Extract<
  AgentInvocation,
  { status: "blocked" | "completed" | "failed" }
> {
  return TERMINAL_AGENT_INVOCATION_STATUSES.includes(
    invocation.status as (typeof TERMINAL_AGENT_INVOCATION_STATUSES)[number],
  );
}
