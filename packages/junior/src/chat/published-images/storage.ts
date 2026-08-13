import type { AttachmentStorage } from "@/chat/attachments/storage";

/**
 * Object storage used for publicly readable published images.
 *
 * Reuses the attachment storage put/get surface. Keys stay under the
 * published-images prefix so conversation attachments remain separate.
 */
export type PublishedImageStorage = Pick<
  AttachmentStorage,
  "provider" | "put" | "get"
>;
