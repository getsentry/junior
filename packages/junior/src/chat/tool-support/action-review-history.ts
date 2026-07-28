import type { PiMessage } from "@/chat/pi/messages";
import { z } from "zod";
import type { Actor } from "@/chat/actor";
import {
  sameActorIdentity,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";
import {
  toolActionRejectionKey,
  type ToolActionRejection,
} from "@/chat/tool-support/action-review";

const MAX_VISIBLE_HISTORY_CHARS = 12_000;
const priorRejectionSchema = z
  .object({
    decision: z.enum(["ask", "deny"]),
    input: z.record(z.string(), z.unknown()),
    reason: z.string().min(1),
    riskLevel: z.enum(["low", "medium", "high", "critical"]).optional(),
    tool: z
      .object({
        annotations: z.record(z.string(), z.unknown()).optional(),
        description: z.string(),
        dispatcherName: z.string().optional(),
        identity: z
          .object({
            id: z.string(),
            name: z.string(),
            plugin: z.string(),
          })
          .strict()
          .optional(),
        name: z.string(),
        proposalDescription: z.string().optional(),
        catalogSource: z
          .object({
            description: z.string(),
            id: z.string(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    userAuthorization: z.enum(["high", "medium", "low", "unknown"]).optional(),
  })
  .strict();
export type ToolActionPriorRejection = z.output<typeof priorRejectionSchema>;

const rejectionMarkerSchema = z
  .object({
    actionKey: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(["ask", "deny"]),
    priorRejection: priorRejectionSchema,
    reason: z.string().min(1),
    riskLevel: z.enum(["low", "medium", "high", "critical"]).optional(),
    userAuthorization: z.enum(["high", "medium", "low", "unknown"]).optional(),
    version: z.literal(1),
  })
  .strict();
/** Core-owned versioned transcript state binding one rejection to an exact action. */
export type ToolActionRejectionMarker = z.output<typeof rejectionMarkerSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function rejectionMarker(message: Record<string, unknown>) {
  if (!isRecord(message.details)) {
    return undefined;
  }
  const parsed = rejectionMarkerSchema.safeParse(
    message.details.guardianActionRejection,
  );
  return parsed.success ? parsed.data : undefined;
}

/**
 * Consume and project one core-owned rejection into Pi's durable tool result.
 *
 * The marker field is reserved: tool-supplied values are stripped so only
 * state produced by the execution gate can survive into history.
 */
export function projectToolActionRejection<
  TResult extends { details?: unknown; isError?: boolean },
>(
  pending: Map<string, ToolActionRejectionMarker>,
  toolCallId: string,
  result: TResult,
): TResult {
  const rejection = pending.get(toolCallId);
  pending.delete(toolCallId);
  const details = isRecord(result.details) ? result.details : undefined;
  const hasReservedMarker =
    details !== undefined && "guardianActionRejection" in details;
  if (!rejection && !hasReservedMarker) {
    return result;
  }
  const safeDetails = details
    ? Object.fromEntries(
        Object.entries(details).filter(
          ([key]) => key !== "guardianActionRejection",
        ),
      )
    : {};
  return {
    ...result,
    details: {
      ...safeDetails,
      ...(rejection ? { guardianActionRejection: rejection } : {}),
    },
    ...(rejection ? { isError: true } : {}),
  };
}

/**
 * Restore compact Guardian rejection state from the durable Pi transcript.
 *
 * Tool results are not general Guardian evidence. Only core-generated action
 * rejection messages are recognized here and paired with their exact tool call.
 */
export function restoreToolActionReviewState(
  messages: readonly PiMessage[],
  provenance: readonly ConversationMessageProvenance[],
  actor: Actor | undefined,
  userIntent: string,
): {
  priorRejections: ToolActionPriorRejection[];
  rejectedActions: ToolActionRejection[];
} {
  const priorRejections: ToolActionPriorRejection[] = [];
  const rejectedActions: ToolActionRejection[] = [];

  for (const [messageIndex, message] of messages.entries()) {
    const record = message as unknown as Record<string, unknown>;
    if (record.role !== "toolResult" || record.isError !== true) {
      continue;
    }
    const rejection = rejectionMarker(record);
    if (!rejection) {
      continue;
    }
    const hasLaterAuthoritativeIntent = messages
      .slice(messageIndex + 1)
      .some((candidate, offset) => {
        const candidateProvenance = provenance[messageIndex + 1 + offset];
        return (
          candidate.role === "user" &&
          candidateProvenance?.authority === "instruction" &&
          sameActorIdentity(candidateProvenance.actor, actor)
        );
      });
    if (!hasLaterAuthoritativeIntent) {
      rejectedActions.push({
        decision: rejection.decision,
        key: toolActionRejectionKey(
          rejection.decision,
          userIntent,
          rejection.actionKey,
        ),
        reason: rejection.reason,
        reviewedAction: rejection.priorRejection,
        ...(rejection.riskLevel ? { riskLevel: rejection.riskLevel } : {}),
        ...(rejection.userAuthorization
          ? { userAuthorization: rejection.userAuthorization }
          : {}),
      });
    }
    priorRejections.push(rejection.priorRejection);
    while (
      priorRejections.length > 0 &&
      JSON.stringify(priorRejections).length > MAX_VISIBLE_HISTORY_CHARS
    ) {
      priorRejections.shift();
    }
  }

  return { priorRejections, rejectedActions };
}
