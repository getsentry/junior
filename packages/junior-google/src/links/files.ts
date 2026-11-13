/**
 * Link cards for Google Docs, Sheets, and Slides, and for Drive files and
 * folders.
 *
 * Junior's own Google account reads the file, so the card shows only when
 * Drive says that the viewer can open it too. This is the rule of
 * `searchGoogleFiles`. Any unclear case gets no card. A Doc card also shows
 * its first paragraph.
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
  GOOGLE_FILE_TYPES,
  googleFileLinkRoot,
  googleFileType,
  googleLinkFileType,
  resourceKeyHeaders,
  type FileReference,
  type GoogleFileType,
} from "../tools/files";
import { driveQueryString, namedQuery } from "../tools/search-files";
import { googleApiError, googleApiRequest } from "../tools/shared";
import { docSummary } from "./summary";

const DISPLAY_TYPES = {
  document: "Google Doc",
  presentation: "Google Slides",
  spreadsheet: "Google Sheet",
} as const satisfies Record<GoogleFileType, string>;

const linkedFileSchema = z.object({
  driveId: z.string().optional(),
  hasThumbnail: z.boolean().optional(),
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
  // A short-lived link that needs Junior's credential. Never put it in a
  // card: only the image proxy fetches it.
  thumbnailLink: z.string().optional(),
  trashed: z.boolean().optional(),
});

type LinkedFile = z.infer<typeof linkedFileSchema>;

/** What a card or an image read needs to check one viewer. */
type ViewerReadContext = Pick<ObjectLinkContext, "egress" | "viewer">;

const fileIdsSchema = z.object({
  files: z.array(z.object({ id: z.string() })).default([]),
});

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
// A shortcut points to another file that can have other shares.
const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";

// Type labels of other Drive files. Google files use `DISPLAY_TYPES`.
const MIME_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.google-apps.drawing": "Google Drawing",
  "application/vnd.google-apps.folder": "Google Drive folder",
  "application/vnd.google-apps.form": "Google Form",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "PowerPoint presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    "Excel spreadsheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "Word document",
  "application/zip": "ZIP archive",
  "text/csv": "CSV file",
  "text/plain": "Text file",
};
const MIME_GROUP_LABELS: Record<string, string> = {
  audio: "Audio",
  image: "Image",
  video: "Video",
};

function mimeLabel(mimeType: string): string {
  return (
    MIME_LABELS[mimeType] ??
    MIME_GROUP_LABELS[mimeType.split("/")[0] ?? ""] ??
    "File"
  );
}

/** A file that a link names, and the Drive MIME types that the link fits. */
interface FileLink {
  accepts(mimeType: string): boolean;
  file: FileReference;
}

function fileLink(
  url: URL,
  fileId: string | null | undefined,
  accepts: FileLink["accepts"],
): FileLink | undefined {
  if (!fileId || !FILE_ID_PATTERN.test(fileId)) return undefined;
  const resourceKey = url.searchParams.get("resourcekey") ?? undefined;
  return {
    accepts: (mimeType) => mimeType !== SHORTCUT_MIME_TYPE && accepts(mimeType),
    file: { fileId, ...(resourceKey ? { resourceKey } : undefined) },
  };
}

// Drop the account segment of a signed-in link: `/document/u/0/d/<id>` or
// `/drive/u/0/folders/<id>`.
function pathWithoutAccount(url: URL): string[] {
  const [root = "", ...rest] = url.pathname.split("/").slice(1);
  return rest[0] === "u" && /^\d+$/.test(rest[1] ?? "")
    ? [root, ...rest.slice(2)]
    : [root, ...rest];
}

function parseFileLink(url: URL): FileLink | undefined {
  const [root, segment, id] = pathWithoutAccount(url);
  if (url.hostname === "docs.google.com") {
    const type = googleLinkFileType(url);
    return type && segment === "d"
      ? fileLink(url, id, (mimeType) => googleFileType(mimeType) === type)
      : undefined;
  }
  if (root === "file" && segment === "d") {
    return fileLink(url, id, (mimeType) => mimeType !== FOLDER_MIME_TYPE);
  }
  if (root === "drive" && segment === "folders") {
    return fileLink(url, id, (mimeType) => mimeType === FOLDER_MIME_TYPE);
  }
  // `/open?id=<id>` names a file or a folder.
  return url.pathname === "/open"
    ? fileLink(url, url.searchParams.get("id"), () => true)
    : undefined;
}

/**
 * Return whether one Drive query, limited to files with this name, finds
 * the file. A rejected query or a file past the first page counts as no.
 */
async function queryFindsFile(
  ctx: ViewerReadContext,
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
  ctx: ViewerReadContext,
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

/**
 * Read a file that the viewer can open in Drive. Return nothing when Junior's
 * account cannot read it, the link does not fit its type, it is in the
 * trash, or the viewer cannot open it.
 */
export async function readViewerFile(
  ctx: ViewerReadContext,
  link: FileLink,
  allowedDomains: string[],
): Promise<LinkedFile | undefined> {
  const response = await googleApiRequest(ctx, {
    headers: resourceKeyHeaders(link.file),
    operation: "google.drive.file.get",
    path: `/drive/v3/files/${link.file.fileId}`,
    query: {
      fields:
        "driveId,hasThumbnail,id,mimeType,modifiedTime,name,owners(displayName,emailAddress),thumbnailLink,trashed",
      supportsAllDrives: "true",
    },
  });
  // Google answers 404 for a file that Junior's account cannot open.
  if (response.status === 403 || response.status === 404) return undefined;
  if (response.status !== 200) {
    throw googleApiError("google.drive.file.get", response);
  }
  const file = linkedFileSchema.parse(response.body);
  if (file.trashed || !link.accepts(file.mimeType)) return undefined;
  return (await viewerCanOpen(ctx, file, allowedDomains)) ? file : undefined;
}

/** Return the image ref of a file thumbnail, for `googleImages`. */
function thumbnailRef(file: LinkedFile, link: FileLink): string {
  const key = link.file.resourceKey;
  return key ? `${file.id}/${key}` : file.id;
}

/** Return the file link of a thumbnail image ref. */
export function thumbnailFileLink(ref: string): FileLink | undefined {
  const [fileId, resourceKey, extra] = ref.split("/");
  if (!fileId || !FILE_ID_PATTERN.test(fileId) || extra !== undefined) {
    return undefined;
  }
  return {
    accepts: (mimeType) =>
      mimeType !== FOLDER_MIME_TYPE && mimeType !== SHORTCUT_MIME_TYPE,
    file: { fileId, ...(resourceKey ? { resourceKey } : undefined) },
  };
}

async function resolveGoogleFileLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<ObjectAnnotation | undefined> {
  const config = readGoogleConfig();
  const link = parseFileLink(url);
  if (!config || !link) return undefined;
  const file = await readViewerFile(ctx, link, config.allowedDomains);
  if (!file) return undefined;
  // A Drive link to a Doc, Sheet, or Slides file shows the same card as its
  // Docs link.
  const type = googleFileType(file.mimeType);
  const summary =
    type === "document" ? await docSummary(ctx, link.file) : undefined;
  const modifiedAtMs = file.modifiedTime
    ? Date.parse(file.modifiedTime)
    : Number.NaN;
  const thumbnailUrl =
    !type && file.hasThumbnail && file.thumbnailLink
      ? ctx.imagePath(
          thumbnailRef(file, link),
          Number.isFinite(modifiedAtMs) ? String(modifiedAtMs) : undefined,
        )
      : undefined;
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
    displayType: type ? DISPLAY_TYPES[type] : mimeLabel(file.mimeType),
    sourceUpdatedAt: file.modifiedTime,
    facts: {
      type: "document",
      summary,
      owner: ownerName?.slice(0, 160) || undefined,
      modifiedAt: file.modifiedTime,
      thumbnailUrl,
    },
  };
}

const GOOGLE_FILE_DISPLAY_TYPES = new Set<string>(Object.values(DISPLAY_TYPES));

/**
 * Docs, Sheets, and Slides links, and Drive file and folder links, that
 * resolve to document cards.
 */
export const googleFileLinks: PluginObjectLinkDefinition = {
  filters: [
    ...GOOGLE_FILE_TYPES.map(googleFileLinkRoot).flatMap((root) =>
      [`/${root}/d/`, `/${root}/u/`].map((pathPrefix) => ({
        host: "docs.google.com",
        pathPrefix,
      })),
    ),
    // `/drive/u/<n>/` also covers My Drive and other pages that get no card,
    // so no generic web page card shows Drive's sign-in page.
    ...["/file/d/", "/file/u/", "/drive/folders/", "/drive/u/"].map(
      (pathPrefix) => ({ host: "drive.google.com", pathPrefix }),
    ),
    { host: "drive.google.com", path: "/open" },
  ],
  objectType: "document",
  // One tool reads Docs, Sheets, and Slides. No tool reads other files.
  readTool: (object) =>
    object.displayType && GOOGLE_FILE_DISPLAY_TYPES.has(object.displayType)
      ? "readGoogleFile"
      : undefined,
  resolve: resolveGoogleFileLink,
};
