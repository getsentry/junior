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

export const juniorToolErrorSchema = z
  .object({
    kind: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean().optional(),
  })
  .strict();

export const juniorToolResultSchema = z
  .object({
    ok: z.boolean(),
    status: z.enum(["success", "error"]),
    target: z.string().min(1).optional(),
    data: z.unknown().optional(),
    truncated: z.boolean().optional(),
    continuation: juniorToolContinuationSchema.optional(),
    error: z.union([juniorToolErrorSchema, z.string()]).optional(),
  })
  .passthrough();

export const juniorToolResultWithBoundContinuationSchema =
  juniorToolResultSchema.extend({
    continuation: juniorToolBoundContinuationSchema.optional(),
  });

export type JuniorToolResult = z.output<typeof juniorToolResultSchema>;
export type JuniorToolResultWithBoundContinuation = z.output<
  typeof juniorToolResultWithBoundContinuationSchema
>;

export interface JuniorToolResultEnvelope<
  TDetails extends JuniorToolResult = JuniorToolResult,
> {
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
  details: JuniorToolResult,
  toolName: string,
): JuniorToolResult | JuniorToolResultWithBoundContinuation {
  const parsed = juniorToolResultSchema.parse(details);
  if (!isRecord(parsed.continuation)) {
    return parsed;
  }
  return juniorToolResultWithBoundContinuationSchema.parse({
    ...parsed,
    continuation: {
      ...parsed.continuation,
      tool_name: toolName,
    },
  });
}

interface JuniorTextToolResultEnvelope<
  TDetails extends JuniorToolResult = JuniorToolResult,
> {
  content: [TextContent];
  details: TDetails;
}

/** Create the Pi-compatible transport envelope from one structured result object. */
export function makeStructuredToolResult<TDetails extends JuniorToolResult>(
  details: TDetails,
): JuniorTextToolResultEnvelope<TDetails>;
export function makeStructuredToolResult<TDetails extends JuniorToolResult>(
  details: TDetails,
  options: { content: Array<TextContent | ImageContent> },
): JuniorToolResultEnvelope<TDetails>;
export function makeStructuredToolResult<TDetails extends JuniorToolResult>(
  details: TDetails,
  options: { content?: Array<TextContent | ImageContent> } = {},
): JuniorToolResultEnvelope<TDetails> | JuniorTextToolResultEnvelope<TDetails> {
  const parsed = juniorToolResultSchema.parse(details) as TDetails;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(sortJsonValue(parsed)),
      },
      ...(options.content ?? []),
    ],
    details: parsed,
  };
}
