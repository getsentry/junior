import {
  definePluginTool,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { GOOGLE_DOC_MIME_TYPE } from "./docs";
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
      .describe("Words to find in the Doc title or text."),
    maxResults: z.number().int().min(1).max(50).default(10),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("searchGoogleDocs"),
  documents: z.array(
    z.object({
      documentId: z.string(),
      modifiedTime: z.string().optional(),
      title: z.string(),
      url: z.string().optional(),
    }),
  ),
  truncated: z
    .boolean()
    .describe(
      "True when more Docs match, or Google did not search every Drive.",
    ),
});

const fileListSchema = z.object({
  files: z
    .array(
      z.object({
        id: z.string(),
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

/** Find Google Docs that Junior's account can open, by title or text. */
export function createSearchGoogleDocsTool(ctx: GoogleToolContext) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description:
      "Find Google Docs shared with Junior's own Google account, by words in the title or text. Docs that are only shared by public link are not found; ask for their link and use readGoogleDoc instead. Returns document ids for readGoogleDoc and listGoogleDocComments.",
    inputSchema,
    outputSchema,
    async execute(input) {
      const response = await googleApiRequest(ctx, {
        operation: "google.drive.files.list",
        path: "/drive/v3/files",
        query: {
          corpora: "allDrives",
          fields:
            "files(id,modifiedTime,name,webViewLink),incompleteSearch,nextPageToken",
          includeItemsFromAllDrives: "true",
          pageSize: String(input.maxResults),
          q: `mimeType = '${GOOGLE_DOC_MIME_TYPE}' and trashed = false and fullText contains ${driveQueryString(input.query)}`,
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
        target: "searchGoogleDocs" as const,
        documents: files.map((file) => ({
          documentId: file.id,
          ...(file.modifiedTime
            ? { modifiedTime: file.modifiedTime }
            : undefined),
          title: file.name,
          ...(file.webViewLink ? { url: file.webViewLink } : undefined),
        })),
        truncated: nextPageToken !== undefined || incompleteSearch === true,
      };
    },
  });
}
