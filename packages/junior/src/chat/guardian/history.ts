import type { PiMessage } from "@/chat/pi/messages";
import * as z from "zod";
import { CODEMODE_TOOL_NAME } from "@/chat/codemode/result";
import {
  RISK_LEVELS,
  USER_AUTHORIZATION_LEVELS,
} from "@/chat/guardian/proposal";

/** Most characters of serialized prior rejections that Guardian sees. */
const MAX_PRIOR_REJECTION_CHARS = 12_000;
const priorRejectionSchema = z
  .object({
    decision: z.enum(["ask", "deny"]),
    input: z.record(z.string(), z.unknown()),
    reason: z.string().min(1),
    riskLevel: z.enum(RISK_LEVELS).optional(),
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
    userAuthorization: z.enum(USER_AUTHORIZATION_LEVELS).optional(),
  })
  .strict();
export type ToolActionPriorRejection = z.output<typeof priorRejectionSchema>;

const rejectionMarkerSchema = z
  .object({
    decision: z.enum(["ask", "deny"]),
    priorRejection: priorRejectionSchema,
    reason: z.string().min(1),
    riskLevel: z.enum(RISK_LEVELS).optional(),
    userAuthorization: z.enum(USER_AUTHORIZATION_LEVELS).optional(),
    version: z.literal(1),
  })
  .strict();
/**
 * Core-owned versioned transcript state for one rejected action. Stored
 * transcripts keep it, so a shape change needs a new version.
 */
export type ToolActionRejectionMarker = z.output<typeof rejectionMarkerSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Read a core-owned action rejection marker from one durable Pi message. */
export function getToolActionRejectionMarker(
  message: unknown,
): ToolActionRejectionMarker | undefined {
  if (!isRecord(message) || !isRecord(message.details)) {
    return undefined;
  }
  const parsed = rejectionMarkerSchema.safeParse(
    message.details.guardianActionRejection,
  );
  return parsed.success ? parsed.data : undefined;
}

/**
 * Read the markers of the nested calls in one `codemode` tool result, in
 * call order. The bridge copies each marker from the gate.
 */
function getCodeModeRejectionMarkers(
  message: Record<string, unknown>,
): ToolActionRejectionMarker[] {
  if (
    message.toolName !== CODEMODE_TOOL_NAME ||
    !isRecord(message.details) ||
    !Array.isArray(message.details.calls)
  ) {
    return [];
  }
  return message.details.calls.flatMap((call: unknown) => {
    const marker = getToolActionRejectionMarker({ details: call });
    return marker ? [marker] : [];
  });
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
      ...(rejection ? { guardianActionRejection: rejection } : undefined),
    },
    ...(rejection ? { isError: true } : undefined),
  };
}

/**
 * Add one rejection to the prior rejections that Guardian sees, and drop the
 * oldest ones until the list fits the character budget. The gate and the
 * restore from history use this, so both keep the same window.
 */
export function addPriorRejection(
  rejections: ToolActionPriorRejection[],
  rejection: ToolActionPriorRejection,
): void {
  rejections.push(rejection);
  while (
    rejections.length > 0 &&
    JSON.stringify(rejections).length > MAX_PRIOR_REJECTION_CHARS
  ) {
    rejections.shift();
  }
}

/**
 * Restore compact Guardian rejection state from the durable Pi transcript.
 *
 * Tool results are not general Guardian evidence. Only core-generated action
 * rejection messages are recognized here and paired with their exact tool call.
 */
export function restoreToolActionRejections(
  messages: readonly PiMessage[],
): ToolActionPriorRejection[] {
  const priorRejections: ToolActionPriorRejection[] = [];

  for (const message of messages) {
    const record = message as PiMessage & Record<string, unknown>;
    if (record.role !== "toolResult") {
      continue;
    }
    // A script can finish after a nested call was rejected, so its result
    // need not be an error.
    for (const rejection of getCodeModeRejectionMarkers(record)) {
      addPriorRejection(priorRejections, rejection.priorRejection);
    }
    if (!record.isError) {
      continue;
    }
    const rejection = getToolActionRejectionMarker(record);
    if (!rejection) {
      continue;
    }
    addPriorRejection(priorRejections, rejection.priorRejection);
  }

  return priorRejections;
}
