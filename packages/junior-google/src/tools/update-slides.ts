import {
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import pLimit from "p-limit";
import * as z from "zod";
import { revisionAfterUpdate } from "./doc-edits";
import { requireEditableFile } from "./editable-file";
import { readRequesterFile } from "./file-access";
import { FILE_ID_PATTERN, googleFileRequest } from "./files";
import type { GoogleToolContext } from "./shared";
import { presentationReferenceSchema, presentationUrl } from "./slides";

// Google validates each request. The tool checks only the shape that every
// batchUpdate request has: one key, the request kind.
const requestSchema = z
  .record(z.string(), z.unknown())
  .refine((request) => Object.keys(request).length === 1, {
    message: "Each request has exactly one key, such as insertText.",
  });

const inputSchema = z
  .object({
    presentation: presentationReferenceSchema,
    revision_id: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe(
        "revision_id from readGoogleSlidesLayout, or from your last edit of this presentation. Google refuses the edit if someone changed the presentation after that.",
      ),
    requests: z
      .array(requestSchema)
      .min(1)
      .max(200)
      .describe(
        'Slides API batchUpdate requests, applied in order, such as {"insertText": {...}}. See https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/request.',
      ),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("updateGoogleSlides"),
  presentation_id: z.string(),
  replies: z
    .array(z.unknown())
    .describe(
      "One reply per request, in order, such as the objectId of a created slide or the number of replaced matches.",
    ),
  revision_id: z
    .string()
    .optional()
    .describe(
      "Revision after this edit. Pass it as revision_id to edit again without reading first.",
    ),
  title: z.string(),
  url: z.string(),
});

// Request kinds that copy content from another file into the deck.
const sheetsSourceSchema = z.object({
  spreadsheetId: z
    .string()
    .regex(FILE_ID_PATTERN, "spreadsheetId must be a Drive file id")
    .optional(),
});
const sourceSchema = z.object({
  createSheetsChart: sheetsSourceSchema.optional(),
  createVideo: z.object({ source: z.string().optional() }).optional(),
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Slides API request kind.
  replaceAllShapesWithSheetsChart: sheetsSourceSchema.optional(),
});
const SOURCE_CHECK_CONCURRENCY = 4;

/** Return the first object key in a value that is not camelCase. */
function snakeCaseKey(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const key = snakeCaseKey(item);
      if (key) return key;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (key.includes("_")) return key;
    const nested = snakeCaseKey(item);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Check every other file that the requests copy into the deck. A Sheets
 * chart shows data from its Sheet, so the requester must be able to open that
 * Sheet. Junior cannot check a Drive video, so only YouTube videos are
 * allowed.
 */
async function requireReadableSources(
  ctx: GoogleToolContext,
  requests: Array<Record<string, unknown>>,
): Promise<void> {
  // Google also reads snake_case names, such as spreadsheet_id, but the
  // checks below read only camelCase.
  const snakeCase = snakeCaseKey(requests);
  if (snakeCase) {
    throw new PluginToolInputError(
      `Write Slides API field names in camelCase, not ${snakeCase}.`,
    );
  }
  // A refresh reads the chart's Sheet, which the request does not name.
  if (requests.some((request) => "refreshSheetsChart" in request)) {
    throw new PluginToolInputError(
      "refreshSheetsChart is not supported: you cannot check who can open the chart's Sheet.",
    );
  }
  const sources = requests.map((request) => {
    const parsed = sourceSchema.safeParse(request);
    if (!parsed.success) {
      throw new PluginToolInputError(
        `Malformed ${Object.keys(request)[0]} request: ${parsed.error.issues[0]?.message ?? "invalid"}.`,
      );
    }
    return parsed.data;
  });
  if (
    sources.some(
      (source) =>
        source.createVideo !== undefined &&
        source.createVideo.source !== "YOUTUBE",
    )
  ) {
    throw new PluginToolInputError(
      "Only YouTube videos can be added. You cannot check who can open a Drive video.",
    );
  }
  const spreadsheetIds = new Set(
    sources.flatMap((source) =>
      [
        source.createSheetsChart?.spreadsheetId,
        // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Slides API request kind.
        source.replaceAllShapesWithSheetsChart?.spreadsheetId,
      ].filter((id) => id !== undefined),
    ),
  );
  await pLimit(SOURCE_CHECK_CONCURRENCY).map([...spreadsheetIds], (fileId) =>
    readRequesterFile(ctx, { fileId }, ["spreadsheet"]),
  );
}

const replySchema = z.object({ replies: z.array(z.unknown()).default([]) });

/** Count request kinds for the action review proposal, such as `insertText ×2`. */
function describeRequests(requests: Array<Record<string, unknown>>): string {
  const counts = new Map<string, number>();
  for (const request of requests) {
    const kind = Object.keys(request)[0] ?? "unknown";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts]
    .map(([kind, count]) => (count > 1 ? `${kind} ×${count}` : kind))
    .join(", ");
}

/** Apply Slides API batchUpdate requests to one presentation. */
export const updateGoogleSlidesTool = definePluginTool({
  annotations: {
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
    readOnlyHint: false,
  },
  describeProposal(input) {
    return `In Google Slides ${input.presentation}, apply ${input.requests.length} edit(s): ${describeRequests(input.requests)}.`;
  },
  description:
    "Edit a Google Slides presentation with Slides API batchUpdate requests, as your own Google account: add, duplicate, move, or delete slides and elements, and change text, styles, and positions. All requests apply together or not at all. Read the layout with readGoogleSlidesLayout first, and check layout changes with getGoogleSlideThumbnail. Works only when that account and the requester can both edit the presentation. A Sheets chart needs a Sheet that the requester can open; videos must be from YouTube.",
  inputSchema,
  outputSchema,
  async execute(input, _options, ctx: GoogleToolContext) {
    const file = await requireEditableFile(
      ctx,
      input.presentation,
      "presentation",
    );
    await requireReadableSources(ctx, input.requests);
    const response = await googleFileRequest(ctx, file.ref, {
      body: {
        requests: input.requests,
        writeControl: { requiredRevisionId: input.revision_id },
      },
      editable: file,
      operation: "google.slides.presentation.batchUpdate",
      path: `/v1/presentations/${file.ref.fileId}:batchUpdate`,
    });
    const after = revisionAfterUpdate(response.body);
    return {
      target: "updateGoogleSlides" as const,
      presentation_id: file.ref.fileId,
      replies: replySchema.parse(response.body).replies,
      ...(after ? { revision_id: after } : undefined),
      title: file.title,
      url: file.webViewLink ?? presentationUrl(file.ref.fileId),
    };
  },
});
