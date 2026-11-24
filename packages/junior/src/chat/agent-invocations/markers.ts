/**
 * Records of child agent work. The parent Conversation gets one
 * `subagent_started` and one `subagent_ended` event for each parent message
 * to a child. The dashboard shows them, and `listAgents` reads each child's
 * newest outcome as its last result. No other runtime rule reads them.
 */
import type { StateAdapter } from "chat";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { readAgentConfig } from "@/chat/conversations/agent-config";
import { getConversationEventStore, getSqlExecutor } from "@/chat/db";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { juniorConversationEvents } from "@/db/schema";
import type { TurnReasoningLevel } from "@/chat/reasoning-level";
import { readChildConversationSender } from "./child-input";
import type { ChildAgentResult } from "./types";

// The dashboard labels each child row with this kind.
const SUBAGENT_KIND = "agent";
const SUBAGENT_STARTED_KEY_PREFIX = "subagent_started:";
const SUBAGENT_ENDED_KEY_PREFIX = "subagent_ended:";

/**
 * The fields of one `subagent_started` marker. `markerId`, the id of the
 * parent message, names the marker and its `subagent_ended`. A retry with
 * the same id writes nothing.
 */
export type SubagentStart = {
  agentName?: string | undefined;
  childConversationId: string;
  createdAtMs: number;
  input: string;
  markerId: string;
  parentConversationId: string;
  parentToolCallId: string;
  reasoningLevel?: TurnReasoningLevel | undefined;
  title?: string | undefined;
};

/**
 * Record in the parent Conversation that a child agent got one task or
 * message. Write it before the input reaches the child's mailbox, so the
 * child cannot end first.
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
        parentToolCallId: start.parentToolCallId,
        task: start.input,
        ...(start.title ? { title: start.title } : undefined),
        ...(start.reasoningLevel
          ? { reasoningLevel: start.reasoningLevel }
          : undefined),
      },
      createdAtMs: start.createdAtMs,
    },
  ]);
}

/** How the child work that one marker names ended. */
export type SubagentOutcome = "aborted" | "blocked" | "error" | "success";

/**
 * Record in the parent Conversation how the work of a child agent ended.
 * Each parent message has its own `subagent_started` marker, named by the
 * message id, and each one that the child already took ends with `outcome`.
 * A parent message that still waits in the child's mailbox stays open,
 * because later work reads it, unless `includeWaiting` is set, as for a stop
 * that skips it. Write it before the child's result reaches the parent.
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
  // Only a child agent stores an agent config. Its parent messages are the
  // only input with these markers.
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

const startedMarker = alias(juniorConversationEvents, "started_marker");
const endedMarker = alias(juniorConversationEvents, "ended_marker");

/**
 * SQL: the outcome of the newest ended parent message to a child agent, from
 * the parent's markers. A person's Turn in a Thread has no marker.
 */
export function childLastOutcomeSql(
  parentConversationId: string,
  childConversationId: AnyPgColumn,
): SQL<string | null> {
  return sql<
    string | null
  >`(select ${endedMarker.payload}->>'outcome' from ${juniorConversationEvents} as ${endedMarker} join ${juniorConversationEvents} as ${startedMarker} on ${and(
    eq(startedMarker.conversationId, endedMarker.conversationId),
    eq(startedMarker.type, "subagent_started"),
    sql`${startedMarker.payload}->>'subagentInvocationId' = ${endedMarker.payload}->>'subagentInvocationId'`,
  )} where ${and(
    eq(endedMarker.conversationId, parentConversationId),
    eq(endedMarker.type, "subagent_ended"),
    sql`${startedMarker.payload}->>'childConversationId' = ${childConversationId}`,
  )} order by ${endedMarker.seq} desc limit 1)`;
}

// A stop or an error is not a result here: a stop lists the child as
// stopped, and its failed Turn lists it as failed.
const OUTCOME_RESULTS: Partial<Record<string, ChildAgentResult>> = {
  blocked: "blocked",
  success: "completed",
};

/** Map a marker outcome to the child result that it reports, if any. */
export function childResultOfOutcome(
  outcome: string | null,
): ChildAgentResult | undefined {
  return outcome ? OUTCOME_RESULTS[outcome] : undefined;
}
