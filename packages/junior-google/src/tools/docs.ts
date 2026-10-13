import { PluginToolInputError } from "@sentry/junior-plugin-api";
import { z } from "zod";
import type { GoogleOperation } from "../credentials";
import {
  googleApiError,
  googleApiRequest,
  type GoogleToolContext,
} from "./shared";

export const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";

/** Doc id or link input for the tools that read one Doc. */
export const docReferenceSchema = z
  .string()
  .trim()
  .min(10)
  .max(2048)
  .describe(
    "Google Docs link, or a document id from searchGoogleDocs. Keep the full link for Docs shared by link: it can carry a resource key that Google needs.",
  );

const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;

/** One Drive file, and the resource key that a link-shared file can need. */
export interface DocReference {
  fileId: string;
  resourceKey?: string;
}

/**
 * Return the file id and resource key from a Doc id or link.
 *
 * Links look like `docs.google.com/document/d/<id>/edit`,
 * `drive.google.com/file/d/<id>/view`, or `drive.google.com/open?id=<id>`.
 * Older Docs shared by link also need the link's `resourcekey` value.
 */
export function parseDocReference(value: string): DocReference {
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
      "Use a Google Docs link or a document id from searchGoogleDocs.",
    );
  }
  return { fileId, ...(resourceKey ? { resourceKey } : undefined) };
}

/** Call one Drive operation on a file, with its resource key when known. */
export async function driveFileRequest(
  ctx: GoogleToolContext,
  doc: DocReference,
  input: {
    headers?: Record<string, string>;
    operation: GoogleOperation;
    path: string;
    query?: Record<string, string>;
  },
): Promise<{ body: unknown; status: number }> {
  const response = await googleApiRequest(ctx, {
    ...input,
    headers: {
      ...input.headers,
      ...(doc.resourceKey
        ? {
            "X-Goog-Drive-Resource-Keys": `${doc.fileId}/${doc.resourceKey}`,
          }
        : undefined),
    },
  });
  // Drive returns 404 for a file that Junior's account cannot open.
  if (response.status === 404) {
    throw new PluginToolInputError(
      `Junior's Google account (${ctx.accountEmail}) cannot open this Doc. Ask the owner to share it with that account, or to share it with anyone who has the link.`,
    );
  }
  if (response.status !== 200) {
    throw googleApiError(input.operation, response);
  }
  return response;
}
