/**
 * Link cards for Google Docs, Sheets, and Slides.
 *
 * Junior's own Google account reads the file, so the card shows only when
 * Drive says that the viewer can open it too. This is the rule of
 * `searchGoogleFiles`. Any unclear case gets no card.
 */
import type {
  ObjectAnnotation,
  ObjectLinkContext,
  PluginObjectLinkDefinition,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { emailDomain, readGoogleConfig } from "../config";
import {
  FILE_ID_PATTERN,
  googleFileType,
  resourceKeyHeaders,
  type FileReference,
  type GoogleFileType,
} from "../tools/files";
import { driveQueryString, namedQuery } from "../tools/search-files";
import { googleApiError, googleApiRequest } from "../tools/shared";

const LINK_PATHS = {
  document: "/document/d/",
  presentation: "/presentation/d/",
  spreadsheet: "/spreadsheets/d/",
} as const satisfies Record<GoogleFileType, string>;

const DISPLAY_TYPES = {
  document: "Google Doc",
  presentation: "Google Slides",
  spreadsheet: "Google Sheet",
} as const satisfies Record<GoogleFileType, string>;

const linkedFileSchema = z.object({
  driveId: z.string().optional(),
  id: z.string(),
  mimeType: z.string(),
  modifiedTime: z.string().optional(),
  name: z.string(),
  owners: z
    .array(
      z.object({
        displayName: z.string().optional(),
        emailAddress: z.string().optional(),
      }),
    )
    .optional(),
  trashed: z.boolean().optional(),
});

type LinkedFile = z.infer<typeof linkedFileSchema>;

const fileIdsSchema = z.object({
  files: z.array(z.object({ id: z.string() })).default([]),
});

function parseFileLink(
  url: URL,
): { file: FileReference; type: GoogleFileType } | undefined {
  for (const [type, prefix] of Object.entries(LINK_PATHS)) {
    if (!url.pathname.startsWith(prefix)) continue;
    const fileId = url.pathname.slice(prefix.length).split("/")[0] ?? "";
    if (!FILE_ID_PATTERN.test(fileId)) return undefined;
    const resourceKey = url.searchParams.get("resourcekey") ?? undefined;
    return {
      file: { fileId, ...(resourceKey ? { resourceKey } : undefined) },
      type: type as GoogleFileType,
    };
  }
  return undefined;
}

/**
 * Return whether one Drive query, limited to files with this name, finds
 * the file. A rejected query or a file past the first page counts as no.
 */
async function queryFindsFile(
  ctx: ObjectLinkContext,
  file: LinkedFile,
  terms: string,
): Promise<boolean> {
  const response = await googleApiRequest(ctx, {
    operation: "google.drive.files.list",
    path: "/drive/v3/files",
    query: {
      corpora: "allDrives",
      fields: "files(id)",
      includeItemsFromAllDrives: "true",
      pageSize: "100",
      q: `name = ${driveQueryString(file.name)} and trashed = false and ${terms}`,
      supportsAllDrives: "true",
    },
  });
  if (response.status === 400) return false;
  if (response.status !== 200) {
    throw googleApiError("google.drive.files.list", response);
  }
  return fileIdsSchema
    .parse(response.body)
    .files.some((item) => item.id === file.id);
}

/**
 * Return whether the viewer can open the file in Drive. The file names the
 * viewer, anyone can open it, or anyone in the viewer's allowed domain can
 * open it and that domain owns it. Group shares do not name the viewer.
 */
async function viewerCanOpen(
  ctx: ObjectLinkContext,
  file: LinkedFile,
  allowedDomains: string[],
): Promise<boolean> {
  const viewer = ctx.viewer.email.toLowerCase();
  const domain = emailDomain(viewer);
  // A shared-drive file has no owner, so only a share that names the viewer
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
    queryFindsFile(ctx, file, namedQuery(viewer)),
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

async function resolveGoogleFileLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<ObjectAnnotation | undefined> {
  const config = readGoogleConfig();
  const link = parseFileLink(url);
  if (!config || !link) return undefined;
  const response = await googleApiRequest(ctx, {
    headers: resourceKeyHeaders(link.file),
    operation: "google.drive.file.get",
    path: `/drive/v3/files/${link.file.fileId}`,
    query: {
      fields:
        "driveId,id,mimeType,modifiedTime,name,owners(displayName,emailAddress),trashed",
      supportsAllDrives: "true",
    },
  });
  // Google answers 404 for a file that Junior's account cannot open.
  if (response.status === 403 || response.status === 404) return undefined;
  if (response.status !== 200) {
    throw googleApiError("google.drive.file.get", response);
  }
  const file = linkedFileSchema.parse(response.body);
  if (file.trashed || googleFileType(file.mimeType) !== link.type) {
    return undefined;
  }
  if (!(await viewerCanOpen(ctx, file, config.allowedDomains))) {
    return undefined;
  }
  const owner = file.owners?.[0];
  const ownerName = (owner?.displayName || owner?.emailAddress)?.trim();
  const title = file.name.trim() || "Untitled";
  return {
    kind: "object",
    objectType: "document",
    key: file.id,
    label: title.slice(0, 80),
    title: title.slice(0, 512),
    url: url.href,
    displayType: DISPLAY_TYPES[link.type],
    sourceUpdatedAt: file.modifiedTime,
    facts: {
      type: "document",
      owner: ownerName?.slice(0, 160) || undefined,
      modifiedAt: file.modifiedTime,
    },
  };
}

/** Docs, Sheets, and Slides links that resolve to document cards. */
export const googleFileLinks: PluginObjectLinkDefinition = {
  filters: Object.values(LINK_PATHS).map((pathPrefix) => ({
    host: "docs.google.com",
    pathPrefix,
  })),
  objectType: "document",
  resolve: resolveGoogleFileLink,
};
