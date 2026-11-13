import {
  definePluginTool,
  pluginToolDefinition,
  pluginToolOutputSchema,
  PluginToolInputError,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  fileOutputFields,
  fileReferenceSchema,
  GOOGLE_FILE_TYPES,
  googleLinkFileType,
  MAX_CONTENT_CHARS,
  parseFileReference,
  readGoogleFileMetadata,
} from "./files";
import { docOutputFields, readDocContent } from "./read-doc";
import { readSheetContent, sheetOutputFields } from "./read-sheet";
import { readSlidesContent, slidesOutputFields } from "./read-slides";
import type { GoogleToolContext } from "./shared";

const inputSchema = z
  .object({
    file: fileReferenceSchema("Google Docs, Sheets, or Slides"),
    range: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe(
        "Sheets only: the A1 range to read, such as 'Budget' for one tab or 'Budget!A1:F50'. Omit to read every tab.",
      ),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("readGoogleFile"),
  file_id: z.string(),
  modified_at: z.string().optional(),
  title: z.string(),
  truncated: z
    .boolean()
    .describe(
      `True when the content is longer than ${MAX_CONTENT_CHARS} characters and the end is left out. For a Sheet, pass a smaller range to read the rest.`,
    ),
  type: z.enum(GOOGLE_FILE_TYPES),
  url: z.string().optional(),
  ...docOutputFields,
  ...sheetOutputFields,
  ...slidesOutputFields,
});

export const readGoogleFileToolDefinition = pluginToolDefinition({
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: true,
  },
  description:
    "Read one Google Doc, Sheet, or Slides presentation by link or file id, as your own Google account sees it. A Doc returns Markdown and a revision_id for the Doc edit tools, a Sheet returns cells as CSV, and Slides return slide text and speaker notes. Works for files shared with that account or with anyone who has the link. Comments are not included; use listGoogleFileComments. Contents can be private: share only what the requester needs, and avoid repeating them in public channels.",
  inputSchema,
  outputSchema,
});

/**
 * Read one Google Doc, Sheet, or Slides file, whichever the link or file id
 * names.
 *
 * A Docs, Sheets, or Slides link names its type in the path, and the file
 * must have that type. A bare file id, or a Drive link, takes the type from
 * the file's Drive MIME type.
 */
export function createReadGoogleFileTool(ctx: GoogleToolContext) {
  return definePluginTool({
    ...readGoogleFileToolDefinition,
    async execute(input) {
      const ref = parseFileReference(input.file);
      const linkType = URL.canParse(input.file)
        ? googleLinkFileType(new URL(input.file))
        : undefined;
      const file = await readGoogleFileMetadata(
        ctx,
        ref,
        linkType ? [linkType] : GOOGLE_FILE_TYPES,
      );
      if (input.range && file.type !== "spreadsheet") {
        throw new PluginToolInputError(
          `"${file.name}" is not a Google Sheet, so it has no range. Read it without one.`,
        );
      }
      const content =
        file.type === "document"
          ? await readDocContent(ctx, ref)
          : file.type === "spreadsheet"
            ? await readSheetContent(ctx, ref, input.range)
            : await readSlidesContent(ctx, ref);
      return {
        target: "readGoogleFile" as const,
        ...fileOutputFields(file),
        ...content,
        file_id: file.id,
        title: file.name,
        type: file.type,
      };
    },
  });
}
