/**
 * Who can read a Google file, for Guardian (`audience` in
 * `design/guardian.md`).
 */
import type {
  Audience,
  GuardianContext,
  GuardianResult,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { emailDomain, readGoogleConfig } from "../config";
import { googleApiRequest } from "../google-api";
import { parseFileReference, resourceKeyHeaders } from "./files";

// Stop after this many permission pages; a file rarely has more.
const MAX_PERMISSION_PAGES = 10;

const permissionsSchema = z.object({
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

/** Whether one Drive share lets someone outside the company read the file. */
function sharedOutside(
  permission: z.infer<typeof permissionsSchema>["permissions"][number],
  allowedDomains: readonly string[],
): boolean {
  if (permission.type === "anyone") return true;
  const domain =
    permission.type === "domain"
      ? permission.domain?.toLowerCase()
      : permission.emailAddress && emailDomain(permission.emailAddress);
  return !domain || !allowedDomains.includes(domain);
}

/**
 * `internal` when every share of the file stays in the company's Workspace
 * domains, else `world`. A read that fails is not an answer, so it counts
 * as `world`.
 */
async function fileAudience(
  ctx: GuardianContext,
  value: string,
): Promise<Audience> {
  const allowedDomains = readGoogleConfig()?.allowedDomains;
  if (!allowedDomains) return "world";
  try {
    const ref = parseFileReference(value);
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PERMISSION_PAGES; page += 1) {
      // oxlint-disable-next-line no-await-in-loop -- Each page needs the page token from the page before.
      const response = await googleApiRequest(ctx, {
        headers: resourceKeyHeaders(ref),
        operation: "google.drive.permissions.list",
        path: `/drive/v3/files/${ref.fileId}/permissions`,
        query: {
          fields: "nextPageToken,permissions(domain,emailAddress,type)",
          pageSize: "100",
          supportsAllDrives: "true",
          ...(pageToken ? { pageToken } : undefined),
        },
      });
      if (response.status !== 200) return "world";
      const body = permissionsSchema.parse(response.body);
      if (body.permissions.some((p) => sharedOutside(p, allowedDomains))) {
        return "world";
      }
      pageToken = body.nextPageToken;
      if (!pageToken) return "internal";
    }
  } catch {
    return "world";
  }
  return "world";
}

/** The `guardian` of a tool that changes an existing Google file. */
export async function fileGuardian(
  noun: string,
  value: string,
  ctx: GuardianContext,
): Promise<GuardianResult> {
  let fileId: string;
  try {
    fileId = parseFileReference(value).fileId;
  } catch {
    // The tool reports the bad reference. Guardian gets an unknown file.
    return { target: `${noun} ${value}`, audience: "world" };
  }
  return {
    target: `${noun} ${fileId}`,
    audience: await fileAudience(ctx, value),
  };
}
