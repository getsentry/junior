/**
 * Read-only Gmail API calls for Junior's own inbox.
 *
 * Only the host heartbeat calls these, with a short-lived access token. The
 * Gmail host is not in the plugin egress domains, so no tool or sandbox
 * command can read mail.
 */
import * as z from "zod";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

const profileSchema = z.object({ historyId: z.string().min(1) });

const historySchema = z.object({
  history: z
    .array(
      z.object({
        id: z.string().min(1),
        messagesAdded: z
          .array(z.object({ message: z.object({ id: z.string().min(1) }) }))
          .optional(),
      }),
    )
    .optional(),
  historyId: z.string().min(1),
  nextPageToken: z.string().optional(),
});

/** One MIME part of a Gmail message in the `full` format. */
export interface GmailPart {
  body?: { data?: string };
  filename?: string;
  headers?: { name: string; value: string }[];
  mimeType?: string;
  parts?: GmailPart[];
}

const partSchema: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    body: z.object({ data: z.string().optional() }).optional(),
    filename: z.string().optional(),
    headers: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .optional(),
    mimeType: z.string().optional(),
    parts: z.array(partSchema).optional(),
  }),
);

const messageSchema = z.object({
  id: z.string().min(1),
  internalDate: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  payload: partSchema,
  threadId: z.string().min(1),
});

/** One Gmail message in the `full` format. */
export type GmailMessage = z.output<typeof messageSchema>;

/** One page of inbox history: the records in order and the next cursor. */
export type GmailHistoryPage = z.output<typeof historySchema>;

async function gmailGet(
  accessToken: string,
  path: string,
  params: Record<string, string | string[]> = {},
): Promise<Response> {
  const url = new URL(`${GMAIL_API}${path}`);
  for (const [name, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(name, item);
    }
  }
  return await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

async function readJson<T>(
  response: Response,
  schema: z.ZodType<T>,
  operation: string,
): Promise<T> {
  if (!response.ok) {
    throw new Error(`Gmail ${operation} failed (http_${response.status})`);
  }
  return schema.parse(await response.json());
}

/** Read the current history id of the mailbox. */
export async function readMailboxHistoryId(
  accessToken: string,
): Promise<string> {
  const profile = await readJson(
    await gmailGet(accessToken, "/profile"),
    profileSchema,
    "profile read",
  );
  return profile.historyId;
}

/**
 * List the messages added to the inbox after one history id. Return
 * `expired` when Gmail no longer keeps that history.
 */
export async function listInboxHistory(
  accessToken: string,
  startHistoryId: string,
  pageToken?: string,
): Promise<GmailHistoryPage | "expired"> {
  const response = await gmailGet(accessToken, "/history", {
    historyTypes: "messageAdded",
    labelId: "INBOX",
    startHistoryId,
    ...(pageToken ? { pageToken } : undefined),
  });
  if (response.status === 404) {
    return "expired";
  }
  return await readJson(response, historySchema, "history list");
}

/**
 * Read one message with its headers and MIME parts. Return undefined when
 * the message was deleted after it reached the inbox.
 */
export async function readMessage(
  accessToken: string,
  messageId: string,
): Promise<GmailMessage | undefined> {
  const response = await gmailGet(
    accessToken,
    `/messages/${encodeURIComponent(messageId)}`,
    { format: "full" },
  );
  if (response.status === 404) {
    return undefined;
  }
  return await readJson(response, messageSchema, "message read");
}
