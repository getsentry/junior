/**
 * The read check for Google files.
 *
 * Junior's account can read every file shared with it, but anyone who can
 * talk to Junior could ask it to. So Junior reads a file only for a person
 * that Drive says can open it too. Link cards use the same check.
 */
import { PluginToolInputError } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { emailDomain } from "../config";
import {
  readGoogleFileMetadata,
  requireFileType,
  resourceKeyHeaders,
  type FileReference,
  type GoogleFileType,
} from "./files";
import { driveQueryString, namedQuery } from "./search-files";
import {
  googleApiError,
  googleApiRequest,
  requesterEmail,
  type GoogleToolContext,
} from "./shared";

/** The Drive fields that the read check needs. */
interface CheckedFile {
  driveId?: string | undefined;
  id: string;
  name: string;
  owners?: { emailAddress?: string | undefined }[] | undefined;
  /** Drive needs the key of an older file shared by link to list it. */
  resourceKey?: string | undefined;
}

type DriveContext = Pick<GoogleToolContext, "egress">;

const fileIdsSchema = z.object({
  files: z.array(z.object({ id: z.string() })).default([]),
  nextPageToken: z.string().optional(),
});
// Many files can share a common name, such as "Untitled document". Stop
// after this many pages.
const MAX_LIST_PAGES = 5;

/**
 * Return whether one Drive query, limited to files with this name, finds
 * the file. A rejected query or a file past the last page read counts as no.
 */
async function queryFindsFile(
  ctx: DriveContext,
  file: CheckedFile,
  terms: string,
): Promise<boolean> {
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- Each page needs the page token from the page before.
    const response = await googleApiRequest(ctx, {
      headers: file.resourceKey
        ? resourceKeyHeaders({ fileId: file.id, resourceKey: file.resourceKey })
        : {},
      operation: "google.drive.files.list",
      path: "/drive/v3/files",
      query: {
        corpora: "allDrives",
        fields: "nextPageToken,files(id)",
        includeItemsFromAllDrives: "true",
        pageSize: "100",
        q: `name = ${driveQueryString(file.name)} and trashed = false and ${terms}`,
        supportsAllDrives: "true",
        ...(pageToken ? { pageToken } : undefined),
      },
    });
    if (response.status === 400) return false;
    if (response.status !== 200) {
      throw googleApiError("google.drive.files.list", response);
    }
    const body = fileIdsSchema.parse(response.body);
    if (body.files.some((item) => item.id === file.id)) return true;
    pageToken = body.nextPageToken;
    if (!pageToken) return false;
  }
  return false;
}

/**
 * Return whether a person can open the file in Drive. The file names them,
 * anyone can open it, or anyone in their allowed domain can open it and that
 * domain owns it. Group shares do not name the person.
 */
export async function personCanOpenFile(
  ctx: DriveContext,
  email: string,
  file: CheckedFile,
  allowedDomains: string[],
): Promise<boolean> {
  const person = email.toLowerCase();
  const domain = emailDomain(person);
  // A shared-drive file has no owner, so only a share that names the person
  // counts.
  const domainOwned =
    !!domain &&
    allowedDomains.includes(domain) &&
    !file.driveId &&
    (file.owners ?? []).some(
      (owner) =>
        !!owner.emailAddress && emailDomain(owner.emailAddress) === domain,
    );
  const checks = await Promise.all([
    queryFindsFile(ctx, file, namedQuery(person)),
    queryFindsFile(
      ctx,
      file,
      "(visibility = 'anyoneWithLink' or visibility = 'anyoneCanFind')",
    ),
    domainOwned
      ? queryFindsFile(
          ctx,
          file,
          "(visibility = 'domainWithLink' or visibility = 'domainCanFind')",
        )
      : false,
  ]);
  return checks.some(Boolean);
}

/**
 * Read the Drive metadata of a file that the requester can open, and
 * require one of the given types. Every tool that reads a file's content or
 * comments starts here. Errors say nothing about the file, such as its
 * title or type, until the requester check passes.
 */
export async function readRequesterFile(
  ctx: GoogleToolContext,
  ref: FileReference,
  types: readonly GoogleFileType[],
) {
  const metadata = await readGoogleFileMetadata(ctx, ref);
  const requester = await requesterEmail(ctx);
  if (!requester) {
    throw new PluginToolInputError(
      "The requester's email is unknown, so the tool cannot check that they may open this file.",
    );
  }
  if (
    !(await personCanOpenFile(
      ctx,
      requester,
      { ...metadata, resourceKey: ref.resourceKey },
      ctx.allowedDomains,
    ))
  ) {
    throw new PluginToolInputError(
      `Only people who can open this file can ask you to read it, and ${requester} cannot. Access through a Google group is not checked: the owner must share it with ${requester}, with their domain, or with anyone who has the link.`,
    );
  }
  return requireFileType(metadata, types);
}
