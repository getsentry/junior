import {
  PluginToolInputError,
  type PluginDownloadUrls,
  type PluginEgress,
  type PluginSandbox,
  type User,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { emailDomain } from "./config";
import { GOOGLE_OPERATIONS, type GoogleOperation } from "./credentials";
import { isEditableFile, type EditableFile } from "./drive/editable-file";

/** Runtime capabilities the Google tools use. */
export interface GoogleToolContext {
  /** The Workspace account Junior acts as, in lowercase. */
  accountEmail: string;
  allowedDomains: string[];
  /** Absent when the host storage cannot sign reads. */
  downloadUrls?: PluginDownloadUrls;
  egress: PluginEgress;
  /** Holds full meeting records and slide thumbnails. */
  sandbox: Pick<PluginSandbox, "readFile" | "root" | "run" | "writeFile">;
  users: {
    resolveActor(): Promise<{ user?: User } | undefined>;
    resolveTimezone(): Promise<string>;
  };
}

export const emailListSchema = (max: number) =>
  z
    .array(z.string().trim().toLowerCase().pipe(z.email()))
    .max(max)
    .describe("Attendee email addresses.");

export const timeZoneSchema = z
  .string()
  .min(1)
  .refine(isTimeZone, "time_zone must be an IANA time zone")
  .optional()
  .describe(
    "IANA time zone used to read and show times, such as America/Los_Angeles. Omit to use the requester's time zone.",
  );

/** True when the runtime knows this IANA time zone. */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Reject people outside the domains Junior may look up or invite. */
export function requireAllowedEmails(
  emails: string[],
  allowedDomains: string[],
): void {
  const outside = emails.filter((email) => {
    const domain = emailDomain(email);
    return !domain || !allowedDomains.includes(domain);
  });
  if (outside.length > 0) {
    throw new PluginToolInputError(
      `You can only schedule with people at ${allowedDomains.join(", ")}. Not allowed: ${outside.join(", ")}`,
    );
  }
}

/** Return the requester's email in lowercase, when Junior knows it. */
export async function requesterEmail(
  ctx: GoogleToolContext,
): Promise<string | undefined> {
  return (await ctx.users.resolveActor())?.user?.email?.trim().toLowerCase();
}

/**
 * Add the requester's email when Junior knows it and it is in an allowed
 * domain. People rarely type their own address.
 */
export async function withRequester(
  ctx: GoogleToolContext,
  emails: string[],
): Promise<string[]> {
  const requester = await requesterEmail(ctx);
  const domain = requester ? emailDomain(requester) : undefined;
  const all =
    requester && domain && ctx.allowedDomains.includes(domain)
      ? [requester, ...emails]
      : emails;
  return [...new Set(all)];
}

const googleErrorSchema = z.object({
  error: z
    .object({
      details: z.array(z.object({ reason: z.string().optional() })).optional(),
      message: z.string().optional(),
    })
    .optional(),
});

/**
 * Call one Google API operation through host-owned egress.
 *
 * A JSON response body is parsed. Other bodies, such as a Drive export, are
 * returned as text.
 */
export async function googleApiRequest(
  ctx: Pick<GoogleToolContext, "egress">,
  input: {
    body?: unknown;
    /** Required by operations that change an existing file. */
    editable?: EditableFile;
    headers?: Record<string, string>;
    operation: GoogleOperation;
    path: string;
    /** A list value repeats the parameter, as Sheets `ranges` needs. */
    query?: Record<string, string | string[]>;
  },
): Promise<{ body: unknown; status: number }> {
  const rule = GOOGLE_OPERATIONS[input.operation];
  const url = new URL(`https://${rule.host}${input.path}`);
  // Junior's account can edit files that the requester cannot. Every change
  // to an existing file must pass the file that `requireEditableFile`
  // checked, and change only that file, so no tool can skip the requester
  // check. The rule's path captures the changed file id.
  if (
    "writeCheck" in rule &&
    rule.writeCheck === "file-editor" &&
    (!isEditableFile(input.editable) ||
      url.search !== "" ||
      url.hash !== "" ||
      rule.path.exec(url.pathname)?.[1] !== input.editable.ref.fileId)
  ) {
    throw new Error(
      `${input.operation} changes a file, so it needs the file that requireEditableFile checked.`,
    );
  }
  for (const [key, value] of Object.entries(input.query ?? {})) {
    for (const item of [value].flat()) {
      url.searchParams.append(key, item);
    }
  }
  const response = await ctx.egress.fetch({
    operation: input.operation,
    provider: "google",
    request: new Request(url, {
      method: rule.method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...input.headers,
      },
      body: input.body === undefined ? null : JSON.stringify(input.body),
    }),
  });
  const body: unknown = response.headers.get("content-type")?.includes("json")
    ? await response.json().catch(() => undefined)
    : (await response.text()) || undefined;
  return { body, status: response.status };
}

/** Turn a failed Google response into a tool error. */
export function googleApiError(
  operation: GoogleOperation,
  response: { body: unknown; status: number },
): Error {
  const parsed = googleErrorSchema.safeParse(response.body);
  const error = parsed.success ? parsed.data.error : undefined;
  // A grant made before a tool needed a scope lacks it. Only a new sign-in
  // can add it.
  if (
    response.status === 403 &&
    error?.details?.some(
      (detail) => detail.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
    )
  ) {
    return new Error(
      `Your own Google account does not have the permission that ${operation} needs. An admin must reconnect it on the dashboard Admin page or with \`junior google connect\`.`,
    );
  }
  // Each Google API must be enabled in the Cloud project of the OAuth client.
  if (
    response.status === 403 &&
    error?.details?.some((detail) => detail.reason === "SERVICE_DISABLED")
  ) {
    return new Error(
      `The Google API that ${operation} needs is not enabled for the connected Google Cloud project. An admin must enable it.`,
    );
  }
  const detail = error?.message;
  const message = `Google ${operation} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
  return response.status === 400
    ? new PluginToolInputError(message)
    : new Error(message);
}
