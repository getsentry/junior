import {
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { emailDomain } from "../config";
import {
  fileOutputFields,
  GOOGLE_FILE_TYPES,
  googleFileMimeType,
  googleFileType,
  type GoogleFileType,
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
        driveId: z.string().optional(),
        id: z.string(),
        mimeType: z.string(),
        modifiedTime: z.string().optional(),
        name: z.string(),
        owners: z
          .array(z.object({ emailAddress: z.string().optional() }))
          .optional(),
        webViewLink: z.string().optional(),
      }),
    )
    .default([]),
  incompleteSearch: z.boolean().optional(),
  nextPageToken: z.string().optional(),
});

type DriveFile = z.infer<typeof fileListSchema>["files"][number];

/** Quote a value for a Drive search query. */
function driveQueryString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Drive search terms for files that name the requester in a permission. */
function namedQuery(requester: string): string {
  const email = driveQueryString(requester);
  return `(${email} in readers or ${email} in writers or ${email} in owners)`;
}

/**
 * Drive search terms for files that anyone in a domain, or anyone at all, can
 * find. Files shared only by link never match. The terms do not say which
 * domain, so `isShown` also checks the owner.
 */
const FINDABLE_QUERY =
  "(visibility = 'domainCanFind' or visibility = 'anyoneCanFind')";

/**
 * Keep a file only when an allowed domain owns it. A file in a shared drive
 * has no owners, so it shows only when it names the requester. A file with no
 * owner data never shows.
 */
function isShown(
  file: DriveFile,
  namedIds: Set<string>,
  allowedDomains: string[],
): boolean {
  if (file.driveId) {
    return namedIds.has(file.id);
  }
  return (file.owners ?? []).some((owner) => {
    const domain = owner.emailAddress && emailDomain(owner.emailAddress);
    return !!domain && allowedDomains.includes(domain);
  });
}

async function listDriveFiles(
  ctx: GoogleToolContext,
  q: string,
  pageSize: number,
) {
  const response = await googleApiRequest(ctx, {
    operation: "google.drive.files.list",
    path: "/drive/v3/files",
    query: {
      corpora: "allDrives",
      fields:
        "files(driveId,id,mimeType,modifiedTime,name,owners(emailAddress),webViewLink),incompleteSearch,nextPageToken",
      includeItemsFromAllDrives: "true",
      pageSize: String(pageSize),
      q,
      supportsAllDrives: "true",
    },
  });
  // Google answers 400 to a query it rejects.
  if (response.status === 400) {
    return undefined;
  }
  if (response.status !== 200) {
    throw googleApiError("google.drive.files.list", response);
  }
  return fileListSchema.parse(response.body);
}

/**
 * Find files that the requester could find in Drive themselves: files that
 * name them, and files that anyone in an allowed domain can find. Returns
 * undefined when Google rejects a query.
 */
async function searchFindableFiles(
  ctx: GoogleToolContext,
  input: {
    maxResults: number;
    query: string;
    requester: string;
    types: readonly GoogleFileType[];
  },
): Promise<{ files: DriveFile[]; truncated: boolean } | undefined> {
  const mimeTypes = input.types
    .map((type) => `mimeType = '${googleFileMimeType(type)}'`)
    .join(" or ");
  const terms = `(${mimeTypes}) and trashed = false and fullText contains ${driveQueryString(input.query)}`;
  const [named, findable] = await Promise.all([
    listDriveFiles(
      ctx,
      `${terms} and ${namedQuery(input.requester)}`,
      input.maxResults,
    ),
    listDriveFiles(ctx, `${terms} and ${FINDABLE_QUERY}`, input.maxResults),
  ]);
  if (!named || !findable) {
    return undefined;
  }
  const namedIds = new Set(named.files.map((file) => file.id));
  const shown = [
    ...new Map(
      [...named.files, ...findable.files].map((file) => [file.id, file]),
    ).values(),
  ].filter((file) => isShown(file, namedIds, ctx.allowedDomains));
  return {
    files: shown.slice(0, input.maxResults),
    truncated:
      shown.length > input.maxResults ||
      [named, findable].some(
        (list) =>
          list.nextPageToken !== undefined || list.incompleteSearch === true,
      ),
  };
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
      "Find Google Docs, Sheets, and Slides by words in the title or text. Finds only company-owned files that anyone in the company can find in Drive, or that are shared with the requester by name. Shared-drive files are found only when shared with the requester by name. Files shared by link, shared only with other people or groups, or owned outside the company are never found; ask the requester for their link instead. Returns file ids for readGoogleDoc, readGoogleSheet, readGoogleSlides, and listGoogleFileComments.",
    inputSchema,
    outputSchema,
    async execute(input) {
      const requester = await requesterEmail(ctx);
      // Domain-findable files are findable only inside the allowed domains,
      // so search only for requesters in them.
      const domain = requester ? emailDomain(requester) : undefined;
      if (!requester || !domain || !ctx.allowedDomains.includes(domain)) {
        throw new PluginToolInputError(
          `Search works only for requesters with a known email at ${ctx.allowedDomains.join(", ")}. ${PASTE_LINK}`,
        );
      }
      const found = await searchFindableFiles(ctx, {
        maxResults: input.max_results,
        query: input.query,
        requester,
        types: input.types ?? GOOGLE_FILE_TYPES,
      });
      // Never retry a rejected query without the requester's terms.
      if (!found) {
        throw new PluginToolInputError(
          `Google rejected the search. ${PASTE_LINK}`,
        );
      }
      return {
        target: "searchGoogleFiles" as const,
        files: found.files.flatMap((file) => {
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
        truncated: found.truncated,
      };
    },
  });
}
