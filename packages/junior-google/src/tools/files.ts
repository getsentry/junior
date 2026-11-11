import { PluginToolInputError } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { emailDomain } from "../config";
import type { GoogleOperation } from "../credentials";
import {
  googleApiError,
  googleApiRequest,
  requesterEmail,
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

/** A Drive file id, as the file tools accept it. */
export const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;

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
      `Your Google account (${ctx.accountEmail}) cannot open this file. Ask the owner to share it with that account, or to share it with anyone who has the link.`,
    );
  }
  if (response.status !== 200) {
    throw googleApiError(input.operation, response);
  }
  return response;
}

const driveFileSchema = z.object({
  capabilities: z.object({ canShare: z.boolean().optional() }).optional(),
  id: z.string(),
  mimeType: z.string(),
  modifiedTime: z.string().optional(),
  name: z.string(),
  webViewLink: z.string().optional(),
});

const permissionPageSchema = z.object({
  nextPageToken: z.string().optional(),
  permissions: z
    .array(
      z.object({
        domain: z.string().optional(),
        emailAddress: z.string().optional(),
        type: z.string(),
      }),
    )
    .default([]),
});

const fileIdPageSchema = z.object({
  files: z.array(z.object({ id: z.string() })).default([]),
  nextPageToken: z.string().optional(),
});

/** Quote a value for a Drive search query. */
export function driveQueryString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * Drive search terms that match files the requester can open through their
 * own email, a link, or the domain of Junior's account.
 *
 * `visibility` does not say which domain a domain share is for. A file
 * shared with another domain counts as shared with Junior's domain, so a
 * requester in Junior's domain is assumed to open it. Group members are not
 * matched.
 */
export function requesterAccessQuery(
  ctx: GoogleToolContext,
  requester: string,
): string {
  const email = driveQueryString(requester);
  const visibility =
    emailDomain(requester) === emailDomain(ctx.accountEmail)
      ? "visibility != 'limited'"
      : "visibility = 'anyoneCanFind' or visibility = 'anyoneWithLink'";
  return `(${visibility} or ${email} in readers or ${email} in writers or ${email} in owners)`;
}

/**
 * Read the file's permissions, which Drive lists only to accounts that can
 * share the file. Exact, except that group members are not matched.
 */
async function listedAccess(
  ctx: GoogleToolContext,
  file: FileReference,
  requester: string,
): Promise<"open" | "group" | "none"> {
  const domain = emailDomain(requester);
  let group = false;
  let pageToken: string | undefined;
  do {
    const response = await googleFileRequest(ctx, file, {
      operation: "google.drive.permissions.list",
      path: `/drive/v3/files/${file.fileId}/permissions`,
      query: {
        fields: "nextPageToken,permissions(domain,emailAddress,type)",
        pageSize: "100",
        supportsAllDrives: "true",
        ...(pageToken ? { pageToken } : undefined),
      },
    });
    const page = permissionPageSchema.parse(response.body);
    for (const permission of page.permissions) {
      if (
        permission.type === "anyone" ||
        (permission.type === "domain" &&
          permission.domain?.toLowerCase() === domain) ||
        (permission.type === "user" &&
          permission.emailAddress?.toLowerCase() === requester)
      ) {
        return "open";
      }
      if (permission.type === "group") group = true;
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return group ? "group" : "none";
}

/**
 * Search for the file by its exact name with the requester's access terms.
 * Works when Junior's account can only view the file.
 */
async function searchedAccess(
  ctx: GoogleToolContext,
  file: FileReference & { name: string },
  requester: string,
): Promise<boolean> {
  let pageToken: string | undefined;
  do {
    const response = await googleApiRequest(ctx, {
      operation: "google.drive.files.list",
      path: "/drive/v3/files",
      query: {
        corpora: "allDrives",
        fields: "files(id),nextPageToken",
        includeItemsFromAllDrives: "true",
        pageSize: "100",
        q: `name = ${driveQueryString(file.name)} and ${requesterAccessQuery(ctx, requester)}`,
        supportsAllDrives: "true",
        ...(pageToken ? { pageToken } : undefined),
      },
    });
    if (response.status !== 200) {
      throw googleApiError("google.drive.files.list", response);
    }
    const page = fileIdPageSchema.parse(response.body);
    if (page.files.some((found) => found.id === file.fileId)) return true;
    pageToken = page.nextPageToken;
  } while (pageToken);
  return false;
}

/** Return the requester's email, or refuse a read when it is unknown. */
export async function requireRequesterEmail(
  ctx: GoogleToolContext,
): Promise<string> {
  const requester = await requesterEmail(ctx);
  if (!requester) {
    throw new PluginToolInputError(
      "The requester's email is unknown, so the tool cannot check that they may open Google files.",
    );
  }
  return requester;
}

/**
 * Refuse a read unless the requester can open the file themselves, through
 * their own email, their domain, or a link. Junior's account sees every file
 * shared with it, and anyone who can talk to Junior uses that account.
 */
async function requireRequesterAccess(
  ctx: GoogleToolContext,
  file: FileReference & { canShare?: boolean; name: string },
): Promise<void> {
  const requester = await requireRequesterEmail(ctx);
  const fix = `Ask the owner to share it with ${requester} directly or with their domain.`;
  if (file.canShare === true) {
    const access = await listedAccess(ctx, file, requester);
    if (access === "open") return;
    throw new PluginToolInputError(
      access === "group"
        ? `${requester} has no access to "${file.name}" through their own email, their domain, or a link. It is shared with a Google group, and group membership is not checked. ${fix}`
        : `${requester} cannot open "${file.name}". You read a file only for people who can open it themselves. ${fix}`,
    );
  }
  if (await searchedAccess(ctx, file, requester)) return;
  throw new PluginToolInputError(
    `Google shows no access for ${requester} to "${file.name}" through their own email, their domain, or a link. You read a file only for people who can open it themselves. Access through a Google group is not checked. ${fix}`,
  );
}

/**
 * Read the Drive metadata of one file, require one of the given types, and
 * require that the requester can open it.
 *
 * `drive.readonly` can read any Drive file, so each tool checks the type
 * and the requester's access before it reads content or comments.
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
      fields:
        "capabilities(canShare),id,mimeType,modifiedTime,name,webViewLink",
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
  await requireRequesterAccess(ctx, {
    ...file,
    canShare: metadata.capabilities?.canShare,
    name: metadata.name,
  });
  return { ...metadata, type };
}

/** Optional output fields shared by the tools that read one file. */
export function fileOutputFields(file: {
  modifiedTime?: string;
  webViewLink?: string;
}) {
  return {
    ...(file.modifiedTime ? { modified_at: file.modifiedTime } : undefined),
    ...(file.webViewLink ? { url: file.webViewLink } : undefined),
  };
}

/** Longest file text that one tool result returns. */
export const MAX_CONTENT_CHARS = 100_000;
