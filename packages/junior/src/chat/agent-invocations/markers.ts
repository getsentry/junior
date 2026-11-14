/**
 * Dashboard records for agent invocations. The parent Conversation gets one
 * `subagent_started` and one `subagent_ended` event for each agent invocation.
 * The child Conversation gets `message` events for its input and its result,
 * because a child posts nothing to its Location.
 */
import type { StateAdapter } from "chat";
import { and, eq, gt, sql } from "drizzle-orm";
import { getConversationEventStore, getSqlExecutor } from "@/chat/db";
import type { ConversationMessageMeta } from "@/chat/state/conversation";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { juniorConversationEvents } from "@/db/schema";
import { readChildConversationSender } from "./child-input";
import { getAgentInvocationMessageId } from "./ids";
import { getLatestAgentInvocationForConversation } from "./store";
import type { AgentInvocation, TerminalAgentInvocation } from "./types";

// The dashboard labels each child row with this kind.
const SUBAGENT_KIND = "agent";

/**
 * Record in the parent Conversation that one agent invocation started, and
 * record its input as a user message in the child Conversation. The dashboard
 * pairs the parent event with `subagent_ended` to show the child and its
 * status. It must be written before the child mailbox append, so the child
 * cannot end first. An agent wrote the input, not a person, so the message
 * names its agent invocation instead of an author. Input from Events, such as
 * the child's own Watch Events, passes their Event fields, so the dashboard
 * shows it as an Event, as on a root.
 */
export async function recordSubagentStarted(
  invocation: AgentInvocation,
  eventMeta?: ConversationMessageMeta,
): Promise<void> {
  const eventStore = getConversationEventStore();
  // The mailbox input has the same id, so the child Turn links to it.
  const messageId = getAgentInvocationMessageId(invocation.invocationId);
  await eventStore.append(invocation.childConversationId, [
    {
      idempotencyKey: `message:${messageId}`,
      data: {
        type: "message",
        messageId,
        role: "user",
        text: invocation.input,
        meta: { ...eventMeta, agentInvocationId: invocation.invocationId },
      },
      createdAtMs: invocation.createdAtMs,
    },
  ]);
  await recordSubagentStartedMarker(invocation);
}

/**
 * The fields of one `subagent_started` marker. A child with no Agent
 * invocation uses the id that an Agent invocation for the same idempotency
 * key would have, so a retry writes nothing.
 */
export type SubagentStart = Pick<
  AgentInvocation,
  | "agentName"
  | "childConversationId"
  | "createdAtMs"
  | "input"
  | "invocationId"
  | "parentConversationId"
  | "parentToolCallId"
  | "reasoningLevel"
  | "title"
>;

/**
 * Record in the parent Conversation that a child agent got one task,
 * message, or other input. Write it before the input reaches the child's
 * mailbox, so the child cannot end first.
 */
export async function recordSubagentStartedMarker(
  start: SubagentStart,
): Promise<void> {
  await getConversationEventStore().append(start.parentConversationId, [
    {
      idempotencyKey: `subagent_started:${start.invocationId}`,
      data: {
        type: "subagent_started",
        subagentInvocationId: start.invocationId,
        subagentKind: SUBAGENT_KIND,
        childConversationId: start.childConversationId,
        ...(start.agentName ? { agentName: start.agentName } : undefined),
        // Only a `spawnAgent` or `messageAgent` call has a task. An agent
        // invocation that receives a nested result or message has another
        // child's output as its input.
        ...(start.parentToolCallId
          ? { parentToolCallId: start.parentToolCallId, task: start.input }
          : undefined),
        ...(start.title ? { title: start.title } : undefined),
        ...(start.reasoningLevel
          ? { reasoningLevel: start.reasoningLevel }
          : undefined),
      },
      createdAtMs: start.createdAtMs,
    },
  ]);
}

const SUBAGENT_OUTCOMES = {
  blocked: "blocked",
  completed: "success",
  failed: "error",
  stopped: "aborted",
} as const satisfies Record<TerminalAgentInvocation["status"], string>;

type SubagentOutcome =
  (typeof SUBAGENT_OUTCOMES)[keyof typeof SUBAGENT_OUTCOMES];

/**
 * Record in the parent Conversation how one agent invocation ended, and record
 * a completed result as an assistant message in the child Conversation. The
 * heartbeat result repair also calls this, because the child work can be
 * acknowledged before the worker reports the result.
 */
export async function recordSubagentEnded(
  invocation: TerminalAgentInvocation,
): Promise<void> {
  const eventStore = getConversationEventStore();
  // Write the parent outcome first. The child message only feeds the child
  // transcript, so it must not hold back how the parent sees the child end.
  await appendSubagentEnded(
    invocation.parentConversationId,
    [invocation.invocationId],
    SUBAGENT_OUTCOMES[invocation.status],
    invocation.terminalAtMs,
  );
  const result =
    invocation.status === "completed" ? invocation.result.trim() : "";
  if (!result) return;
  const messageId = `agent-invocation:${invocation.invocationId}:reply`;
  await eventStore.append(invocation.childConversationId, [
    {
      idempotencyKey: `message:${messageId}`,
      data: {
        type: "message",
        messageId,
        role: "assistant",
        text: result,
      },
      createdAtMs: invocation.terminalAtMs,
    },
  ]);
}

/**
 * Record in the parent Conversation how the work of a child agent with no
 * Agent invocation ended: each `subagent_started` marker of the child that
 * has not ended yet ends with `outcome`. A marker whose parent
 * message still waits in the child's mailbox stays open, because later work
 * reads it, unless `includeWaiting` is set, as for a stop that skips it.
 * Write it before the child's result reaches the parent. A child that an
 * Agent invocation names ends its markers with its rows.
 */
export async function recordChildAgentEnded(
  childConversationId: string,
  outcome: SubagentOutcome,
  options: {
    includeWaiting?: boolean;
    nowMs?: number;
    state?: StateAdapter | undefined;
  } = {},
): Promise<void> {
  if (await getLatestAgentInvocationForConversation(childConversationId)) {
    return;
  }
  const sender = await readChildConversationSender(childConversationId);
  if (!sender) {
    return;
  }
  const db = getSqlExecutor().db();
  const payload = juniorConversationEvents.payload;
  const markerId = sql<string>`${payload}->>'subagentInvocationId'`;
  const started = (
    await db
      .select({ markerId })
      .from(juniorConversationEvents)
      .where(
        and(
          eq(
            juniorConversationEvents.conversationId,
            sender.parentConversationId,
          ),
          eq(juniorConversationEvents.type, "subagent_started"),
          sql`${payload}->>'childConversationId' = ${childConversationId}`,
        ),
      )
  ).map((row) => row.markerId);
  const waiting = new Set(
    options.includeWaiting
      ? []
      : ((
          await getConversationWorkState({
            conversationId: childConversationId,
            state: options.state,
          })
        )?.messages.map((message) => message.inboundMessageId) ?? []),
  );
  await appendSubagentEnded(
    sender.parentConversationId,
    started.filter((id) => !waiting.has(getAgentInvocationMessageId(id))),
    outcome,
    options.nowMs ?? Date.now(),
  );
}

// A marker that already ended keeps its outcome: its key is taken.
async function appendSubagentEnded(
  parentConversationId: string,
  invocationIds: readonly string[],
  outcome: SubagentOutcome,
  createdAtMs: number,
): Promise<void> {
  await getConversationEventStore().append(
    parentConversationId,
    invocationIds.map((id) => ({
      idempotencyKey: `subagent_ended:${id}`,
      data: { type: "subagent_ended", subagentInvocationId: id, outcome },
      createdAtMs,
    })),
  );
}

/**
 * List the child agents with no Agent invocation that a parent gave a task
 * or message after `afterMs`, from the parent's `subagent_started` markers.
 */
export async function listChildAgentsStartedAfter(
  parentConversationId: string,
  afterMs: number,
): Promise<string[]> {
  const childConversationId = sql<string>`${juniorConversationEvents.payload}->>'childConversationId'`;
  const rows = await getSqlExecutor()
    .db()
    .selectDistinct({ childConversationId })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, parentConversationId),
        eq(juniorConversationEvents.type, "subagent_started"),
        gt(juniorConversationEvents.createdAt, new Date(afterMs)),
      ),
    );
  return rows.map((row) => row.childConversationId);
}
