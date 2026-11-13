import {
  INLINE_VIDEO_TYPES,
  INPUT_IMAGE_TYPES,
} from "@/chat/attachments/media";
import type { User } from "@sentry/junior-plugin-api";
import { getProductionSlackAdapter } from "@/chat/app/production";
import {
  AttachmentDownloadError,
  ensureAttachmentStored,
} from "@/chat/attachments/download";
import type { MessageAttachment } from "@/chat/attachments/input";
import { readLiveAttachment } from "@/chat/attachments/store";
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
 * Answer one attachment read for an authorized viewer, with one byte range
 * when the request asks for it. Media players need ranges to play and seek.
 *
 * Missing conversations, missing attachments, purge-marked rows, and viewers
 * without private-content access all answer 404.
 */
export async function conversationAttachmentResponse(args: {
  attachmentId: string;
  conversationId: string;
  download: boolean;
  range: string | undefined;
  storage: AttachmentStorage;
  viewer?: User;
}): Promise<Response> {
  await requireAttachmentAccess(args.conversationId, args.viewer);

  const attachment = await readLiveAttachment({
    attachmentId: args.attachmentId,
    conversationId: args.conversationId,
    db: getSqlExecutor(),
  });
  // A file recorded without its bytes has nothing to read until the first
  // loadAttachment downloads it.
  if (
    !attachment ||
    attachment.storageProvider !== args.storage.provider ||
    attachment.storageKey === null
  ) {
    notFound();
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

/**
 * Store one attachment so the byte route can serve it, and return it.
 *
 * A large Slack file that Junior recorded without its bytes downloads from
 * Slack now, with the conversation's Slack installation, through the same
 * first load as `loadAttachment`. A stored file returns at once.
 */
export async function prepareConversationAttachmentDownload(args: {
  attachmentId: string;
  conversationId: string;
  storage: AttachmentStorage;
  viewer: User;
}): Promise<MessageAttachment> {
  const access = await requireAttachmentAccess(
    args.conversationId,
    args.viewer,
  );
  const db = getSqlExecutor();
  const live = await readLiveAttachment({
    attachmentId: args.attachmentId,
    conversationId: args.conversationId,
    db,
  });
  if (!live || live.storageProvider !== args.storage.provider) notFound();

  const teamId =
    access.tenant?.provider === "slack"
      ? parseSlackTeamId(access.tenant.providerTenantId)
      : undefined;
  const store = () =>
    ensureAttachmentStored({
      attachment: live,
      db,
      ...(teamId
        ? { readAttachmentSource: readSlackAttachmentSource }
        : undefined),
      storage: args.storage,
    });
  let stored;
  try {
    stored =
      live.storageKey === null && teamId
        ? await runWithSlackInstallation({
            adapter: getProductionSlackAdapter(),
            installation: { teamId },
            task: store,
          })
        : await store();
  } catch (error) {
    if (error instanceof AttachmentDownloadError) {
      throwApiError(409, error.message, error);
    }
    throw error;
  }
  return {
    bytes: stored.bytes,
    contentType: stored.contentType,
    filename: stored.filename,
    id: stored.id,
  };
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
