/**
 * Dashboard records for child agent work. The parent Conversation gets one
 * `subagent_started` and one `subagent_ended` event for each Agent invocation,
 * or for each parent message to a child that no Agent invocation names. For an
 * Agent invocation, the child Conversation also gets `message` events for its
 * input and its result, because a child posts nothing to its Location.
 * These records are for the dashboard only: no runtime rule reads them.
 */
import type { StateAdapter } from "chat";
import { and, eq, inArray } from "drizzle-orm";
import { readAgentConfig } from "@/chat/conversations/agent-config";
import { getConversationEventStore, getSqlExecutor } from "@/chat/db";
import type { ConversationMessageMeta } from "@/chat/state/conversation";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { juniorConversationEvents } from "@/db/schema";
import { readChildConversationSender } from "./child-input";
import { getAgentInvocationMessageId } from "./ids";
import type { AgentInvocation, TerminalAgentInvocation } from "./types";

// The dashboard labels each child row with this kind.
const SUBAGENT_KIND = "agent";
const SUBAGENT_STARTED_KEY_PREFIX = "subagent_started:";
const SUBAGENT_ENDED_KEY_PREFIX = "subagent_ended:";

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
  await recordSubagentStartedMarker({
    ...invocation,
    markerId: invocation.invocationId,
  });
}

/**
 * The fields of one `subagent_started` marker. `markerId` names the marker
 * and its `subagent_ended`: the Agent invocation id, or for a child with no
 * Agent invocation, the id of the parent message. A retry with the same id
 * writes nothing.
 */
export type SubagentStart = Pick<
  AgentInvocation,
  | "agentName"
  | "childConversationId"
  | "createdAtMs"
  | "input"
  | "parentConversationId"
  | "parentToolCallId"
  | "reasoningLevel"
  | "title"
> & { markerId: string };

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
      idempotencyKey: `${SUBAGENT_STARTED_KEY_PREFIX}${start.markerId}`,
      data: {
        type: "subagent_started",
        subagentInvocationId: start.markerId,
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
 * Agent invocation ended. Each parent message has its own
 * `subagent_started` marker, named by the message id, and each one that the
 * child already took ends with `outcome`. A parent message that still waits
 * in the child's mailbox stays open, because later work reads it, unless
 * `includeWaiting` is set, as for a stop that skips it. Write it before the
 * child's result reaches the parent. A child that an Agent invocation names
 * ends its markers with its rows.
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
  // Only a child that a spawn created without an Agent invocation stores an
  // agent config. Its parent messages are the only input with these markers.
  if (!(await readAgentConfig(childConversationId))) {
    return;
  }
  const work = await getConversationWorkState({
    conversationId: childConversationId,
    state: options.state,
  });
  const running = new Set(work?.runningInboundMessageIds);
  const waiting = new Set(
    options.includeWaiting
      ? []
      : (work?.messages ?? [])
          .map((message) => message.inboundMessageId)
          .filter((id) => !running.has(id)),
  );
  // `inboundMessageIds` holds every id the mailbox got, waiting ones too,
  // and a drop keeps them.
  const taken = (work?.execution.inboundMessageIds ?? []).filter(
    (id) => !waiting.has(id),
  );
  if (taken.length === 0) {
    return;
  }
  const sender = await readChildConversationSender(childConversationId);
  if (!sender) {
    return;
  }
  const keys = await getSqlExecutor()
    .db()
    .select({ idempotencyKey: juniorConversationEvents.idempotencyKey })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(
          juniorConversationEvents.conversationId,
          sender.parentConversationId,
        ),
        inArray(
          juniorConversationEvents.idempotencyKey,
          taken.flatMap((id) => [
            `${SUBAGENT_STARTED_KEY_PREFIX}${id}`,
            `${SUBAGENT_ENDED_KEY_PREFIX}${id}`,
          ]),
        ),
      ),
    );
  const found = new Set(keys.map((row) => row.idempotencyKey));
  const open = taken.filter(
    (id) =>
      found.has(`${SUBAGENT_STARTED_KEY_PREFIX}${id}`) &&
      !found.has(`${SUBAGENT_ENDED_KEY_PREFIX}${id}`),
  );
  if (open.length > 0) {
    await appendSubagentEnded(
      sender.parentConversationId,
      open,
      outcome,
      options.nowMs ?? Date.now(),
    );
  }
}

// A marker that already ended keeps its outcome: its key is taken.
async function appendSubagentEnded(
  parentConversationId: string,
  markerIds: readonly string[],
  outcome: SubagentOutcome,
  createdAtMs: number,
): Promise<void> {
  await getConversationEventStore().append(
    parentConversationId,
    markerIds.map((id) => ({
      idempotencyKey: `${SUBAGENT_ENDED_KEY_PREFIX}${id}`,
      data: { type: "subagent_ended", subagentInvocationId: id, outcome },
      createdAtMs,
    })),
  );
}
