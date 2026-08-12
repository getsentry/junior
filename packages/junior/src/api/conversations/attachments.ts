import type { User } from "@sentry/junior-plugin-api";
import {
  readLiveAttachment,
  type AttachmentRecord,
} from "@/chat/attachments/store";
import type {
  AttachmentContent,
  AttachmentStorage,
} from "@/chat/attachments/storage";
import { createVercelAttachmentStorage } from "@/chat/attachments/vercel";
import { getDb, getSqlExecutor } from "@/chat/db";
import { throwApiError } from "../http";
import { readConversationAccessFromSql } from "./access";

export interface OpenConversationAttachment {
  attachment: AttachmentRecord;
  body: ReadableStream<Uint8Array>;
  contentType: string;
}

function contentDisposition(filename: string): string {
  const escaped = filename.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `inline; filename="${escaped}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Build response headers for one conversation attachment body. */
export function conversationAttachmentHeaders(args: {
  bytes: number;
  contentType: string;
  filename: string;
}): Headers {
  return new Headers({
    "cache-control": "private, no-store",
    "content-disposition": contentDisposition(args.filename),
    "content-length": String(args.bytes),
    "content-type": args.contentType,
    "x-content-type-options": "nosniff",
  });
}

/**
 * Open one live conversation attachment for an authorized viewer.
 *
 * Missing conversations, missing attachments, purge-marked rows, and viewers
 * without private-content access all return null so the route can answer 404.
 */
export async function openConversationAttachment(args: {
  attachmentId: string;
  conversationId: string;
  storage?: AttachmentStorage;
  viewer?: User;
}): Promise<OpenConversationAttachment | null> {
  const access = (
    await readConversationAccessFromSql(
      getDb(),
      [args.conversationId],
      args.viewer,
    )
  ).get(args.conversationId);
  if (!access?.canViewPrivateContent) return null;

  const attachment = await readLiveAttachment({
    attachmentId: args.attachmentId,
    conversationId: args.conversationId,
    db: getSqlExecutor(),
  });
  if (!attachment) return null;

  const storage = args.storage ?? createVercelAttachmentStorage();
  if (attachment.provider !== storage.provider) return null;

  const content: AttachmentContent | null = await storage.get(
    attachment.storageKey,
  );
  if (!content) return null;

  return {
    attachment,
    body: content.body,
    contentType: content.contentType || attachment.contentType,
  };
}

/** Open one attachment or throw the standard API not-found error. */
export async function requireConversationAttachment(args: {
  attachmentId: string;
  conversationId: string;
  storage?: AttachmentStorage;
  viewer?: User;
}): Promise<OpenConversationAttachment> {
  const opened = await openConversationAttachment(args);
  if (!opened) throwApiError(404, "Attachment not found.");
  return opened;
}
