/**
 * Email requests: people email or CC the bot's Google account, and the bot
 * works on the request in a new public Conversation for the sender.
 *
 * Each heartbeat reads new inbox history. This plugin proves who sent each
 * email (Google's DMARC pass for the `From` domain) and drops automated
 * mail. Core decides whether that address belongs to a trusted person and
 * starts the work. The bot cannot send email.
 */
import type {
  HeartbeatHookContext,
  HeartbeatResult,
} from "@sentry/junior-plugin-api";
import { GOOGLE_GMAIL_SCOPE, type GoogleConfig } from "../config";
import { readGoogleAccessToken } from "../credentials";
import {
  listInboxHistory,
  readMailboxHistoryId,
  readMessage,
  type GmailHistoryPage,
} from "./gmail";
import { readEmailRequest, type EmailRequest } from "./message";

const HISTORY_CURSOR_KEY = "email-requests:history-id";
const POLL_LOCK_KEY = "email-requests:poll";
// The host stops waiting for a plugin heartbeat after 25s.
const POLL_LOCK_TTL_MS = 30_000;
/**
 * Most messages read in one heartbeat. The host also limits dispatches per
 * heartbeat. Later messages wait for the next heartbeat.
 */
const MAX_MESSAGES_PER_POLL = 10;

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Render the sender's first Message. It holds only what the sender chose:
 * the subject, the recipients, and their own words.
 */
function renderEmailRequestInput(request: EmailRequest): string {
  return [
    `Email subject: ${oneLine(request.subject) || "(no subject)"}`,
    ...(request.to.length ? [`To: ${request.to.join(", ")}`] : []),
    ...(request.cc.length ? [`Cc: ${request.cc.join(", ")}`] : []),
    "",
    request.senderText,
  ].join("\n");
}

async function handleMessage(
  ctx: HeartbeatHookContext,
  config: GoogleConfig,
  accessToken: string,
  messageId: string,
): Promise<boolean> {
  const message = await readMessage(accessToken, messageId);
  const read = message
    ? readEmailRequest(message, { accountEmail: config.accountEmail })
    : { dropped: "deleted" as const };
  if ("dropped" in read) {
    ctx.log.info("google.email_request.dropped", {
      "app.google.email_request.reason": read.dropped,
    });
    return false;
  }
  const { request } = read;
  const result = await ctx.agent.dispatchForIdentity({
    idempotencyKey: `google-email:${request.messageId}`,
    input: renderEmailRequestInput(request),
    verifiedEmail: request.senderEmail,
  });
  if (result.status === "not_linked") {
    ctx.log.info("google.email_request.dropped", {
      "app.google.email_request.reason": "not_linked",
    });
    return false;
  }
  return true;
}

/**
 * Read new inbox history after the stored cursor and dispatch each verified
 * request. The cursor moves past a history record only after every message
 * in it is handled, so a failure retries that record on the next heartbeat.
 * Dispatch idempotency makes the retry safe.
 */
async function pollInbox(
  ctx: HeartbeatHookContext,
  config: GoogleConfig,
  accessToken: string,
): Promise<number> {
  const cursor = await ctx.state.get<string>(HISTORY_CURSOR_KEY);
  if (!cursor) {
    // Start at the current mailbox state. Older mail is not a request.
    await ctx.state.set(
      HISTORY_CURSOR_KEY,
      await readMailboxHistoryId(accessToken),
    );
    return 0;
  }

  let next = cursor;
  let read = 0;
  let dispatched = 0;
  let pageToken: string | undefined;
  for (;;) {
    const page: GmailHistoryPage | "expired" = await listInboxHistory(
      accessToken,
      cursor,
      pageToken,
    );
    if (page === "expired") {
      ctx.log.warn("google.email_request.history_expired", {});
      next = await readMailboxHistoryId(accessToken);
      break;
    }
    let stopped = false;
    for (const record of page.history ?? []) {
      const messages = record.messagesAdded ?? [];
      if (read > 0 && read + messages.length > MAX_MESSAGES_PER_POLL) {
        stopped = true;
        break;
      }
      for (const { message } of messages) {
        if (await handleMessage(ctx, config, accessToken, message.id)) {
          dispatched += 1;
        }
        read += 1;
      }
      next = record.id;
    }
    if (stopped) break;
    if (!page.nextPageToken) {
      next = page.historyId;
      break;
    }
    pageToken = page.nextPageToken;
  }
  await ctx.state.set(HISTORY_CURSOR_KEY, next);
  return dispatched;
}

/** Heartbeat hook body: dispatch new email requests from the bot's inbox. */
export async function runEmailRequestHeartbeat(
  ctx: HeartbeatHookContext,
  config: GoogleConfig,
): Promise<HeartbeatResult> {
  return await ctx.state.withLock(POLL_LOCK_KEY, POLL_LOCK_TTL_MS, async () => {
    // No token until an admin connects the account again to grant Gmail.
    // A rejected token disconnects the account, as it does for tools.
    const accessToken = await readGoogleAccessToken(
      ctx,
      config,
      GOOGLE_GMAIL_SCOPE,
    );
    return accessToken
      ? { dispatchCount: await pollInbox(ctx, config, accessToken) }
      : { dispatchCount: 0 };
  });
}
