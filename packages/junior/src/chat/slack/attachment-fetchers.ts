import { downloadPrivateSlackFile } from "@/chat/slack/client";

/**
 * Restore Slack private-file fetchers on message attachments that crossed a
 * serialization boundary.
 */
export function rehydrateAttachmentFetchers(message: {
  attachments: Array<{ fetchData?: unknown; url?: string }>;
}): void {
  for (const attachment of message.attachments) {
    if (!attachment.fetchData && attachment.url) {
      attachment.fetchData = () =>
        downloadPrivateSlackFile(attachment.url as string);
    }
  }
}
