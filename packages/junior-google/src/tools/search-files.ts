import {
  definePluginTool,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  fileOutputFields,
  GOOGLE_FILE_TYPES,
  googleFileMimeType,
  googleFileType,
} from "./files";
import {
  googleApiError,
  googleApiRequest,
  requesterEmail,
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
    max_results: z.number().int().min(1).max(50).default(10),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("searchGoogleFiles"),
  files: z.array(
    z.object({
      file_id: z.string(),
      modified_at: z.string().optional(),
      title: z.string(),
      type: z.enum(GOOGLE_FILE_TYPES),
      url: z.string().optional(),
    }),
  ),
  message: z
    .string()
    .optional()
    .describe("Why no files were searched. Tell the requester."),
  truncated: z
    .boolean()
    .describe(
      "True when more files match, or Google did not search every Drive.",
    ),
});

const PASTE_LINK =
  "Ask the requester to paste a link to the file. You can read files shared with your account by link.";

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

/**
 * Drive search terms for files that any employee could find, or that are
 * shared with the requester by name. Files shared only by link, or only with
 * other people, never match: Junior's account may hold them, but search
 * must not surface them to someone who was not given them.
 */
function findableQuery(requester: string): string {
  const email = driveQueryString(requester);
  return `(visibility = 'domainCanFind' or visibility = 'anyoneCanFind' or ${email} in readers or ${email} in writers or ${email} in owners)`;
}

/**
 * Find Docs, Sheets, and Slides that the requester could find in Drive
 * themselves. Never search without the requester's terms.
 */
export function createSearchGoogleFilesTool(ctx: GoogleToolContext) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description:
      "Find Google Docs, Sheets, and Slides by words in the title or text. Finds only files that anyone in the company can find in Drive, and files shared with the requester by name. Files shared by link, or only with other people, are never found; ask the requester for their link instead. Returns file ids for readGoogleDoc, readGoogleSheet, readGoogleSlides, and listGoogleFileComments.",
    inputSchema,
    outputSchema,
    async execute(input) {
      const requester = await requesterEmail(ctx);
      if (!requester) {
        return {
          target: "searchGoogleFiles" as const,
          files: [],
          message: `The requester's email is unknown, so search cannot check which files they could find. ${PASTE_LINK}`,
          truncated: false,
        };
      }
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
          pageSize: String(input.max_results),
          q: `(${mimeTypes}) and trashed = false and fullText contains ${driveQueryString(input.query)} and ${findableQuery(requester)}`,
          supportsAllDrives: "true",
        },
      });
      // Google answers 400 to a query it rejects. Never retry without the
      // requester's terms.
      if (response.status === 400) {
        return {
          target: "searchGoogleFiles" as const,
          files: [],
          message: `Google rejected the search. ${PASTE_LINK}`,
          truncated: false,
        };
      }
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
                  file_id: file.id,
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
