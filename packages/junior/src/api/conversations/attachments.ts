import {
  INLINE_VIDEO_TYPES,
  INPUT_IMAGE_TYPES,
} from "@/chat/attachments/media";
import type { User } from "@sentry/junior-plugin-api";
import { getProductionSlackAdapter } from "@/chat/app/production";
import {
  AttachmentDownloadError,
  readAttachmentContent,
} from "@/chat/attachments/download";
import {
  readLiveAttachment,
  type AttachmentRecord,
} from "@/chat/attachments/store";
import type { AttachmentStorage, ByteRange } from "@/chat/attachments/storage";
import { getDb, getSqlExecutor } from "@/chat/db";
import { runWithSlackInstallation } from "@/chat/slack/adapter-context";
import { readSlackAttachmentSource } from "@/chat/slack/attachments";
import { parseSlackTeamId } from "@/chat/slack/ids";
import { throwApiError } from "../http";
import {
  readConversationAccessFromSql,
  type ConversationAccess,
} from "./access";

const INLINE_TYPES: readonly string[] = [
  ...INPUT_IMAGE_TYPES,
  ...INLINE_VIDEO_TYPES,
];

function contentDisposition(
  filename: string,
  contentType: string,
  download: boolean,
): string {
  const disposition =
    !download && INLINE_TYPES.includes(contentType) ? "inline" : "attachment";
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Read one `Range` request header against an object size.
 *
 * Return undefined to send the whole object. HTTP lets a server ignore a
 * header it does not support, so this ignores bad syntax and multiple ranges.
 */
function parseRangeHeader(
  header: string | undefined,
  size: number,
): ByteRange | "unsatisfiable" | undefined {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return undefined;
  const [, first = "", last = ""] = match;
  if (!first) {
    // `bytes=-N` asks for the last N bytes.
    if (!last) return undefined;
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const end = last ? Number(last) : Infinity;
  if (end < start) return undefined;
  if (start >= size) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Stream a large Slack file that Junior never stored, from Slack through the
 * host, with the conversation's Slack installation. A HEAD request checks
 * that Slack still has the file without downloading it. Ranges are not
 * supported, so media players cannot seek in these files.
 */
async function slackFileResponse(args: {
  attachment: AttachmentRecord;
  download: boolean;
  headOnly: boolean;
  storage: AttachmentStorage;
  teamId: string | undefined;
}): Promise<Response> {
  const { attachment, teamId } = args;
  const read = async () => {
    const content = await readAttachmentContent({
      attachment,
      ...(teamId
        ? { readAttachmentSource: readSlackAttachmentSource }
        : undefined),
      storage: args.storage,
    });
    return {
      body: args.headOnly ? null : await content.open(),
      bytes: content.bytes,
    };
  };
  let file;
  try {
    file = teamId
      ? await runWithSlackInstallation({
          adapter: getProductionSlackAdapter(),
          installation: { teamId },
          task: read,
        })
      : await read();
  } catch (error) {
    if (error instanceof AttachmentDownloadError) {
      throwApiError(409, error.message, error);
    }
    throw error;
  }
  return new Response(file.body, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": contentDisposition(
        attachment.filename,
        attachment.contentType,
        args.download,
      ),
      "content-length": String(file.bytes),
      "content-type": attachment.contentType,
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Answer one attachment read for an authorized viewer, with one byte range
 * when the request asks for it. Media players need ranges to play and seek.
 *
 * Missing conversations, missing attachments, purge-marked rows, and viewers
 * without private-content access all answer 404. A large Slack file that
 * Junior never stored also needs a signed-in viewer. The row lookup is scoped to
 * the conversation, so a Slack download only ever starts from a row that
 * ingest created there.
 */
export async function conversationAttachmentResponse(args: {
  attachmentId: string;
  conversationId: string;
  download: boolean;
  headOnly: boolean;
  range: string | undefined;
  storage: AttachmentStorage;
  viewer?: User;
}): Promise<Response> {
  const access = await requireAttachmentAccess(
    args.conversationId,
    args.viewer,
  );

  const attachment = await readLiveAttachment({
    attachmentId: args.attachmentId,
    conversationId: args.conversationId,
    db: getSqlExecutor(),
  });
  if (!attachment || attachment.storageProvider !== args.storage.provider) {
    notFound();
  }
  if (attachment.storageKey === null) {
    // Each read downloads up to the cap from Slack with the bot token, so
    // only a signed-in viewer can start one, even in a public conversation.
    if (!args.viewer) throwApiError(401, "Authentication required.");
    return await slackFileResponse({
      attachment,
      download: args.download,
      headOnly: args.headOnly,
      storage: args.storage,
      teamId:
        access.tenant?.provider === "slack"
          ? parseSlackTeamId(access.tenant.providerTenantId)
          : undefined,
    });
  }

  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  const range = parseRangeHeader(args.range, attachment.bytes);
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${attachment.bytes}`);
    return new Response(null, { headers, status: 416 });
  }

  const body = await args.storage.get(attachment.storageKey, range);
  if (!body) notFound();

  headers.set(
    "content-disposition",
    contentDisposition(
      attachment.filename,
      attachment.contentType,
      args.download,
    ),
  );
  headers.set("content-type", attachment.contentType);
  if (!range) {
    headers.set("content-length", String(attachment.bytes));
    return new Response(body, { headers });
  }
  headers.set(
    "content-range",
    `bytes ${range.start}-${range.end}/${attachment.bytes}`,
  );
  headers.set("content-length", String(range.end - range.start + 1));
  return new Response(body, { headers, status: 206 });
}

async function requireAttachmentAccess(
  conversationId: string,
  viewer: User | undefined,
): Promise<ConversationAccess> {
  const access = (
    await readConversationAccessFromSql(getDb(), [conversationId], viewer)
  ).get(conversationId);
  if (!access?.canViewPrivateContent) notFound();
  return access;
}

function notFound(): never {
  throwApiError(404, "Attachment not found.");
}
