import { PluginToolInputError } from "@sentry/junior-plugin-api";
import { z } from "zod";
import type { GoogleOperation } from "../credentials";
import {
  googleApiError,
  googleApiRequest,
  type GoogleToolContext,
} from "./shared";

/** Google file types that the tools read, with their Drive MIME types. */
const FILE_TYPES = {
  document: {
    label: "Google Doc",
    mimeType: "application/vnd.google-apps.document",
  },
  presentation: {
    label: "Google Slides presentation",
    mimeType: "application/vnd.google-apps.presentation",
  },
  spreadsheet: {
    label: "Google Sheet",
    mimeType: "application/vnd.google-apps.spreadsheet",
  },
} as const;

export type GoogleFileType = keyof typeof FILE_TYPES;

export const GOOGLE_FILE_TYPES = Object.keys(FILE_TYPES) as GoogleFileType[];

/** Return the Drive MIME type of one file type. */
export function googleFileMimeType(type: GoogleFileType): string {
  return FILE_TYPES[type].mimeType;
}

/** Return the file type of a Drive MIME type, when the tools read it. */
export function googleFileType(mimeType: string): GoogleFileType | undefined {
  return GOOGLE_FILE_TYPES.find(
    (type) => FILE_TYPES[type].mimeType === mimeType,
  );
}

/** File id or link input for the tools that use one file. */
export function fileReferenceSchema(name: string) {
  return z
    .string()
    .trim()
    .min(10)
    .max(2048)
    .describe(
      `${name} link, or a file id from searchGoogleFiles. Keep the full link for files shared by link: it can carry a resource key that Google needs.`,
    );
}

const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;

/** One Drive file, and the resource key that a link-shared file can need. */
export interface FileReference {
  fileId: string;
  resourceKey?: string;
}

/**
 * Return the file id and resource key from a file id or link.
 *
 * Links look like `docs.google.com/document/d/<id>/edit`,
 * `docs.google.com/spreadsheets/d/<id>/edit`,
 * `docs.google.com/presentation/d/<id>/edit`,
 * `drive.google.com/file/d/<id>/view`, or `drive.google.com/open?id=<id>`.
 * Older files shared by link also need the link's `resourcekey` value.
 */
export function parseFileReference(value: string): FileReference {
  let fileId = value;
  let resourceKey: string | undefined;
  if (/^https?:\/\//.test(value)) {
    const url = URL.parse(value);
    fileId =
      url?.pathname.match(/\/d\/([^/]+)/)?.[1] ??
      url?.searchParams.get("id") ??
      "";
    resourceKey = url?.searchParams.get("resourcekey") ?? undefined;
  }
  if (!FILE_ID_PATTERN.test(fileId)) {
    throw new PluginToolInputError(
      "Use a Google Docs, Sheets, or Slides link, or a file id from searchGoogleFiles.",
    );
  }
  return { fileId, ...(resourceKey ? { resourceKey } : undefined) };
}

/** Call one Google operation on a file, with its resource key when known. */
export async function googleFileRequest(
  ctx: GoogleToolContext,
  file: FileReference,
  input: {
    headers?: Record<string, string>;
    operation: GoogleOperation;
    path: string;
    query?: Record<string, string | string[]>;
  },
): Promise<{ body: unknown; status: number }> {
  const response = await googleApiRequest(ctx, {
    ...input,
    headers: {
      ...input.headers,
      ...(file.resourceKey
        ? {
            "X-Goog-Drive-Resource-Keys": `${file.fileId}/${file.resourceKey}`,
          }
        : undefined),
    },
  });
  // Google returns 404 for a file that Junior's account cannot open.
  if (response.status === 404) {
    throw new PluginToolInputError(
      `Junior's Google account (${ctx.accountEmail}) cannot open this file. Ask the owner to share it with that account, or to share it with anyone who has the link.`,
    );
  }
  if (response.status !== 200) {
    throw googleApiError(input.operation, response);
  }
  return response;
}

const driveFileSchema = z.object({
  id: z.string(),
  mimeType: z.string(),
  modifiedTime: z.string().optional(),
  name: z.string(),
  webViewLink: z.string().optional(),
});

/**
 * Read the Drive metadata of one file, and require one of the given types.
 *
 * `drive.readonly` can read any Drive file, so each tool checks the type
 * before it reads content or comments.
 */
export async function readGoogleFile(
  ctx: GoogleToolContext,
  file: FileReference,
  types: readonly GoogleFileType[],
) {
  const response = await googleFileRequest(ctx, file, {
    operation: "google.drive.file.get",
    path: `/drive/v3/files/${file.fileId}`,
    query: {
      fields: "id,mimeType,modifiedTime,name,webViewLink",
      supportsAllDrives: "true",
    },
  });
  const metadata = driveFileSchema.parse(response.body);
  const type = googleFileType(metadata.mimeType);
  if (!type || !types.includes(type)) {
    const expected = types.map((item) => FILE_TYPES[item].label).join(" or ");
    throw new PluginToolInputError(
      `"${metadata.name}" is not a ${expected} (${metadata.mimeType}).`,
    );
  }
  return { ...metadata, type };
}

/** Optional output fields shared by the tools that read one file. */
export function fileOutputFields(file: {
  modifiedTime?: string;
  webViewLink?: string;
}) {
  return {
    ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : undefined),
    ...(file.webViewLink ? { url: file.webViewLink } : undefined),
  };
}

/** Longest file text that one tool result returns. */
export const MAX_CONTENT_CHARS = 100_000;
