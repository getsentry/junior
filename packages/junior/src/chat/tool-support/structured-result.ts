import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { z } from "zod";

export const juniorToolContinuationSchema = z
  .object({
    tool_name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
    reason: z.string().min(1).optional(),
  })
  .strict();

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
    error: juniorToolErrorSchema.optional(),
  })
  .passthrough();

export const juniorToolResultEnvelopeSchema = z
  .object({
    content: z.array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string() }).strict(),
        z
          .object({
            type: z.literal("image"),
            data: z.string(),
            mimeType: z.string(),
          })
          .strict(),
      ]),
    ),
    details: juniorToolResultSchema,
  })
  .strict();

export type JuniorToolResult = z.output<typeof juniorToolResultSchema>;

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

export interface JuniorTextToolResultEnvelope<
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
