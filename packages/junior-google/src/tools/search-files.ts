import {
  definePluginTool,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  fileOutputFields,
  GOOGLE_FILE_TYPES,
  googleFileMimeType,
  googleFileType,
} from "./files";
import {
  googleApiError,
  googleApiRequest,
  type GoogleToolContext,
} from "./shared";

const inputSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("Words to find in the file title or text."),
    types: z
      .array(z.enum(GOOGLE_FILE_TYPES))
      .min(1)
      .optional()
      .describe(
        "File types to find: document (Docs), spreadsheet (Sheets), presentation (Slides). Omit to find all three.",
      ),
    maxResults: z.number().int().min(1).max(50).default(10),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("searchGoogleFiles"),
  files: z.array(
    z.object({
      fileId: z.string(),
      modifiedTime: z.string().optional(),
      title: z.string(),
      type: z.enum(GOOGLE_FILE_TYPES),
      url: z.string().optional(),
    }),
  ),
  truncated: z
    .boolean()
    .describe(
      "True when more files match, or Google did not search every Drive.",
    ),
});

const fileListSchema = z.object({
  files: z
    .array(
      z.object({
        id: z.string(),
        mimeType: z.string(),
        modifiedTime: z.string().optional(),
        name: z.string(),
        webViewLink: z.string().optional(),
      }),
    )
    .default([]),
  incompleteSearch: z.boolean().optional(),
  nextPageToken: z.string().optional(),
});

/** Quote a value for a Drive search query. */
function driveQueryString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Find Docs, Sheets, and Slides that Junior's account can open. */
export function createSearchGoogleFilesTool(ctx: GoogleToolContext) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description:
      "Find Google Docs, Sheets, and Slides shared with your own Google account, by words in the title or text. Files that are only shared by public link are not found; ask for their link instead. Returns file ids for readGoogleDoc, readGoogleSheet, readGoogleSlides, and listGoogleFileComments.",
    inputSchema,
    outputSchema,
    async execute(input) {
      const mimeTypes = (input.types ?? GOOGLE_FILE_TYPES)
        .map((type) => `mimeType = '${googleFileMimeType(type)}'`)
        .join(" or ");
      const response = await googleApiRequest(ctx, {
        operation: "google.drive.files.list",
        path: "/drive/v3/files",
        query: {
          corpora: "allDrives",
          fields:
            "files(id,mimeType,modifiedTime,name,webViewLink),incompleteSearch,nextPageToken",
          includeItemsFromAllDrives: "true",
          pageSize: String(input.maxResults),
          q: `(${mimeTypes}) and trashed = false and fullText contains ${driveQueryString(input.query)}`,
          supportsAllDrives: "true",
        },
      });
      if (response.status !== 200) {
        throw googleApiError("google.drive.files.list", response);
      }
      const { files, incompleteSearch, nextPageToken } = fileListSchema.parse(
        response.body,
      );
      return {
        target: "searchGoogleFiles" as const,
        files: files.flatMap((file) => {
          const type = googleFileType(file.mimeType);
          return type
            ? [
                {
                  fileId: file.id,
                  ...fileOutputFields(file),
                  title: file.name,
                  type,
                },
              ]
            : [];
        }),
        truncated: nextPageToken !== undefined || incompleteSearch === true,
      };
    },
  });
}
