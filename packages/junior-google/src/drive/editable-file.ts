/**
 * Shared check for the tools that write Google Docs and Slides.
 *
 * Junior's account can edit every file shared with it as an editor, but
 * anyone who can talk to Junior could ask it to. So each edit also requires
 * that the requester can edit the file themselves.
 */
import { PluginToolInputError } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { emailDomain } from "../config";
import {
  googleFileRequest,
  parseFileReference,
  readGoogleFileMetadata,
  requireFileType,
  type FileReference,
} from "./files";
import { requesterEmail, type GoogleToolContext } from "../google-api";

const EDIT_ROLES = new Set(["owner", "organizer", "fileOrganizer", "writer"]);
// Stop after this many permission pages; a file rarely has more.
const MAX_PERMISSION_PAGES = 10;

/** Short names that edit errors use for each writable file type. */
const FILE_NOUNS = { document: "Doc", presentation: "presentation" } as const;

type EditableFileType = keyof typeof FILE_NOUNS;

const permissionsSchema = z.object({
  nextPageToken: z.string().optional(),
  permissions: z
    .array(
      z.object({
        domain: z.string().optional(),
        emailAddress: z.string().optional(),
        role: z.string(),
        type: z.string(),
      }),
    )
    .default([]),
});

/**
 * Require that the requester can edit the file through their own email,
 * their domain, or a link that anyone can edit. Group membership is not
 * visible to Junior's account, so a file shared only with a group is refused.
 */
async function requireRequesterCanEdit(
  ctx: GoogleToolContext,
  ref: FileReference,
  noun: string,
): Promise<void> {
  const requester = await requesterEmail(ctx);
  if (!requester) {
    throw new PluginToolInputError(
      `The requester's email is unknown, so the tool cannot check that they may edit this ${noun}.`,
    );
  }
  const domain = emailDomain(requester);
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PERMISSION_PAGES; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- Each page needs the page token from the page before.
    const response = await googleFileRequest(ctx, ref, {
      operation: "google.drive.permissions.list",
      path: `/drive/v3/files/${ref.fileId}/permissions`,
      query: {
        fields: "nextPageToken,permissions(domain,emailAddress,role,type)",
        pageSize: "100",
        supportsAllDrives: "true",
        ...(pageToken ? { pageToken } : undefined),
      },
    });
    const body = permissionsSchema.parse(response.body);
    const canEdit = body.permissions.some(
      (permission) =>
        EDIT_ROLES.has(permission.role) &&
        ((permission.type === "user" &&
          permission.emailAddress?.toLowerCase() === requester) ||
          (permission.type === "domain" &&
            permission.domain?.toLowerCase() === domain) ||
          permission.type === "anyone"),
    );
    if (canEdit) return;
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  throw new PluginToolInputError(
    `Only people who can edit this ${noun} can ask you to change it, and ${requester} is not an editor. Access through a Google group is not checked: the owner must share the ${noun} with ${requester} as an editor.`,
  );
}

// Only this module sets it, so a hand-made object is not an EditableFile.
const CHECKED = Symbol("google.editable-file");

/**
 * A file that the requester may change through Junior's account. Write
 * operations on existing files need one; see `writeCheck` in
 * `credentials.ts`. Only `requireEditableFile` and `newEditableFile` make
 * one.
 */
export interface EditableFile {
  ref: FileReference;
  title: string;
  webViewLink: string | undefined;
}

function checkedFile(file: EditableFile): EditableFile {
  return Object.freeze({ ...file, [CHECKED]: true });
}

/** Return whether a value came from `requireEditableFile` or `newEditableFile`. */
export function isEditableFile(value: unknown): value is EditableFile {
  return (
    typeof value === "object" &&
    value !== null &&
    CHECKED in value &&
    value[CHECKED] === true
  );
}

/** Check that Junior's account and the requester can both edit a file. */
export async function requireEditableFile(
  ctx: GoogleToolContext,
  file: string,
  type: EditableFileType,
): Promise<EditableFile> {
  const ref = parseFileReference(file);
  const metadata = await readGoogleFileMetadata(ctx, ref);
  // Say nothing about the file, such as its title or type, until the
  // requester check passes.
  if (metadata.capabilities?.canEdit !== true) {
    throw new PluginToolInputError(
      `Your Google account (${ctx.accountEmail}) cannot edit this file. Ask the owner to share it with that account as an editor.`,
    );
  }
  await requireRequesterCanEdit(ctx, ref, FILE_NOUNS[type]);
  requireFileType(metadata, [type]);
  return checkedFile({
    ref,
    title: metadata.name,
    webViewLink: metadata.webViewLink,
  });
}

/**
 * Mark a file that the current tool call just created with Junior's account.
 * Only `createGoogleDoc` and `createGoogleSlides` use it: the requester
 * becomes the owner before the call ends, and the file is deleted if that
 * fails.
 */
export function newEditableFile(
  ref: FileReference,
  title: string,
): EditableFile {
  return checkedFile({ ref, title, webViewLink: undefined });
}
