/**
 * Tool approvals in the Conversation's event log. One `ask` call has up to
 * three events, each keyed by its tool call id: the request with the exact
 * call, the claim of the Turn that runs it, and its end. The event store
 * writes a key at most once under the Conversation's event lock, so the
 * first claim wins and the call runs at most once.
 */
import { isDeepStrictEqual } from "node:util";
import type { Destination } from "@sentry/junior-plugin-api";
import type { Actor } from "@/chat/actor";
import type { CredentialContext } from "@/chat/credentials/context";
import type { ConversationEvent } from "@/chat/conversations/history";
import {
  JUNIOR_NATIVE_EVENT_NAMESPACE,
  MAX_TOOL_APPROVAL_RESULT_CHARS,
  toolApprovalFinishedEvent,
  toolApprovalFinishedSchema,
  toolApprovalRequestedEvent,
  toolApprovalRequestedSchema,
  toolApprovalRunStartedEvent,
  toolApprovalRunStartedSchema,
} from "@/chat/conversations/structured-events";
import { getConversationEventStore } from "@/chat/db";

type ToolApprovalEvent =
  | typeof toolApprovalRequestedEvent
  | typeof toolApprovalRunStartedEvent
  | typeof toolApprovalFinishedEvent;

/** The end of one stored call. `declined` means it never runs. */
export interface ToolApprovalEnd {
  result?: string;
  status: "completed" | "failed" | "declined";
}

/** One stored `ask` call and how far it got. */
export interface ToolApproval {
  actor: Actor;
  approverUserId: string;
  /** The Turn that claimed the call to run it. */
  claimTurnId?: string;
  credentialContext?: CredentialContext;
  destination: Destination;
  end?: ToolApprovalEnd;
  input: Record<string, unknown>;
  requestedAtMs: number;
  reviewItemId: string;
  toolCallId: string;
  toolName: string;
}

/** The part of a request that the asking Run gives. */
type ToolApprovalRequest = Omit<
  ToolApproval,
  "claimTurnId" | "end" | "requestedAtMs"
>;

/** Compare a value with its JSON copy in the event log. */
export function sameStoredJson(value: unknown, stored: unknown): boolean {
  return isDeepStrictEqual(
    JSON.parse(JSON.stringify(value ?? null)),
    stored ?? null,
  );
}

function eventKey(definition: ToolApprovalEvent, toolCallId: string): string {
  return `native:${JUNIOR_NATIVE_EVENT_NAMESPACE}:${definition.eventName}:${toolCallId}`;
}

/** Append one event once. Return whether this call wrote it. */
async function appendOnce(
  conversationId: string,
  definition: ToolApprovalEvent,
  args: {
    content: Record<string, unknown>;
    nowMs: number;
    toolCallId: string;
    turnId?: string;
  },
): Promise<boolean> {
  const written = await getConversationEventStore().append(
    conversationId,
    [
      {
        createdAtMs: args.nowMs,
        idempotencyKey: eventKey(definition, args.toolCallId),
        data: {
          type: "structured_event",
          namespace: JUNIOR_NATIVE_EVENT_NAMESPACE,
          name: definition.eventName,
          version: definition.version,
          ...(args.turnId ? { turnId: args.turnId } : undefined),
          content: definition.parse(args.content),
        },
      },
    ],
    { activity: "preserve" },
  );
  return written.length > 0;
}

function contentOf(
  event: ConversationEvent,
  definition: ToolApprovalEvent,
): { content: Record<string, unknown>; turnId?: string } | undefined {
  const { data } = event;
  return data.type === "structured_event" &&
    data.namespace === JUNIOR_NATIVE_EVENT_NAMESPACE &&
    data.name === definition.eventName &&
    data.version === definition.version
    ? { content: data.content, turnId: data.turnId }
    : undefined;
}

/**
 * Store one `ask` call. A retry of the same tool call keeps the first
 * request. Return the stored request.
 */
export async function requestToolApproval(args: {
  conversationId: string;
  nowMs: number;
  request: ToolApprovalRequest;
  turnId: string;
}): Promise<ToolApproval> {
  const { request } = args;
  await appendOnce(args.conversationId, toolApprovalRequestedEvent, {
    content: { ...request },
    nowMs: args.nowMs,
    toolCallId: request.toolCallId,
    turnId: args.turnId,
  });
  const stored = await getToolApproval(args.conversationId, request.toolCallId);
  if (!stored) {
    throw new Error(`Tool approval ${request.toolCallId} is missing`);
  }
  return stored;
}

/** Read the Tool approvals of one Conversation, oldest first. */
export async function listToolApprovals(
  conversationId: string,
): Promise<ToolApproval[]> {
  const events = await getConversationEventStore().loadEventsOfType(
    conversationId,
    "structured_event",
  );
  const approvals = new Map<string, ToolApproval>();
  for (const event of events) {
    const requested = contentOf(event, toolApprovalRequestedEvent);
    if (requested) {
      const content = toolApprovalRequestedSchema.parse(requested.content);
      approvals.set(content.toolCallId, {
        ...content,
        actor: content.actor,
        requestedAtMs: event.createdAtMs,
      });
      continue;
    }
    const claimed = contentOf(event, toolApprovalRunStartedEvent);
    if (claimed) {
      const { toolCallId } = toolApprovalRunStartedSchema.parse(
        claimed.content,
      );
      const approval = approvals.get(toolCallId);
      if (approval) approval.claimTurnId = claimed.turnId;
      continue;
    }
    const ended = contentOf(event, toolApprovalFinishedEvent);
    if (ended) {
      const { toolCallId, ...end } = toolApprovalFinishedSchema.parse(
        ended.content,
      );
      const approval = approvals.get(toolCallId);
      if (approval) approval.end = end;
    }
  }
  return [...approvals.values()];
}

/** Read one Tool approval by its tool call id. */
export async function getToolApproval(
  conversationId: string,
  toolCallId: string,
): Promise<ToolApproval | undefined> {
  return (await listToolApprovals(conversationId)).find(
    (approval) => approval.toolCallId === toolCallId,
  );
}

/**
 * Claim an approved call for one Turn. Return false when a Turn claimed it
 * before, so only one Turn runs it.
 */
export async function claimToolApproval(args: {
  conversationId: string;
  nowMs: number;
  toolCallId: string;
  turnId: string;
}): Promise<boolean> {
  return await appendOnce(args.conversationId, toolApprovalRunStartedEvent, {
    content: { toolCallId: args.toolCallId },
    nowMs: args.nowMs,
    toolCallId: args.toolCallId,
    turnId: args.turnId,
  });
}

/** Record the end of one call. Return false when it already has an end. */
export async function endToolApproval(args: {
  conversationId: string;
  end: ToolApprovalEnd;
  nowMs: number;
  toolCallId: string;
}): Promise<boolean> {
  const result = args.end.result?.trim()
    ? args.end.result.length > MAX_TOOL_APPROVAL_RESULT_CHARS
      ? `${args.end.result.slice(0, MAX_TOOL_APPROVAL_RESULT_CHARS - 8)}\n… (cut)`
      : args.end.result
    : undefined;
  return await appendOnce(args.conversationId, toolApprovalFinishedEvent, {
    content: {
      status: args.end.status,
      toolCallId: args.toolCallId,
      ...(result ? { result } : undefined),
    },
    nowMs: args.nowMs,
    toolCallId: args.toolCallId,
  });
}
