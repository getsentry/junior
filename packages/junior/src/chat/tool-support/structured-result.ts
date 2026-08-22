import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { z } from "zod";

export const juniorToolContinuationSchema = z
  .object({
    arguments: z.record(z.string(), z.unknown()),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const juniorToolBoundContinuationSchema =
  juniorToolContinuationSchema.extend({
    tool_name: z.string().min(1),
  });

/** Shared optional fields for canonical Junior tool outputs. */
export const juniorToolOutputSchema = z
  .object({
    target: z.string().min(1).optional(),
    truncated: z.boolean().optional(),
    /** True when this attempt did not finish before its time budget. */
    timed_out: z.boolean().optional(),
    /**
     * True when durable work is still in progress and the host should re-enter
     * this tool with `continuation.arguments`. Distinct from `timed_out`, which
     * stays model-facing for dead attempts.
     */
    unfinished: z.boolean().optional(),
    /**
     * Next-call arguments. Alone this is model-facing (for example range reads).
     * With `unfinished: true`, the host re-invokes the tool without a model turn.
     */
    continuation: juniorToolContinuationSchema.optional(),
  })
  .passthrough();

export type JuniorToolOutput = z.output<typeof juniorToolOutputSchema>;

export interface JuniorToolOutputEnvelope<TDetails = unknown> {
  content: [TextContent, ...(TextContent | ImageContent)[]];
  details: TDetails;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJsonValue(item)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Bind continuation metadata to the exposed runtime tool name. */
export function injectContinuationToolName(
  details: unknown,
  toolName: string,
): unknown {
  if (!isRecord(details) || !isRecord(details.continuation)) {
    return details;
  }
  return {
    ...details,
    continuation: juniorToolBoundContinuationSchema.parse({
      ...details.continuation,
      tool_name: toolName,
    }),
  };
}

export interface JuniorTextToolOutputEnvelope<TDetails = unknown> {
  content: [TextContent];
  details: TDetails;
}

/**
 * Project one canonical tool output onto Pi's native result channels.
 *
 * This follows the Codex tool-result model: `details` remains the authoritative
 * typed value, while `content` is its model-facing serialization. Telemetry and
 * execution success or failure are separate runtime projections and must not be
 * embedded in the tool output.
 */
export function makeStructuredToolOutput<TDetails>(
  details: TDetails,
): JuniorTextToolOutputEnvelope<TDetails>;
export function makeStructuredToolOutput<TDetails>(
  details: TDetails,
  options: { content: Array<TextContent | ImageContent> },
): JuniorToolOutputEnvelope<TDetails>;
export function makeStructuredToolOutput<TDetails>(
  details: TDetails,
  options: { content?: Array<TextContent | ImageContent> } = {},
): JuniorToolOutputEnvelope<TDetails> | JuniorTextToolOutputEnvelope<TDetails> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(sortJsonValue(details)),
      },
      ...(options.content ?? []),
    ],
    details,
  };
}
