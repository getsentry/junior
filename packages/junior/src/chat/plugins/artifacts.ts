import type { PluginArtifacts } from "@sentry/junior-plugin-api";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { publishImage, unpublishArtifact } from "@/chat/artifacts/store";
import { getSqlExecutor } from "@/chat/db";
import { getChatConfig } from "@/chat/config";

/**
 * Give plugin tools the conversation's public artifacts.
 *
 * Returns undefined when the install has no storage or public base URL, so a
 * plugin tool can refuse instead of guessing at a link.
 */
export function createPluginArtifacts(
  storage: AttachmentStorage | undefined,
  conversationId: string,
): PluginArtifacts | undefined {
  const publicBaseUrl = getChatConfig().deployment.baseUrl;
  if (!storage || !publicBaseUrl) return undefined;
  return {
    async publishImage({ body, expiresInMs }) {
      const image = await publishImage({
        body: Buffer.from(body),
        conversationId,
        db: getSqlExecutor(),
        ...(expiresInMs === undefined
          ? undefined
          : { expiresAt: new Date(Date.now() + expiresInMs) }),
        publicBaseUrl,
        storage,
      });
      return {
        url: image.url,
        ...(image.expiresAt
          ? { expiresAt: image.expiresAt.toISOString() }
          : undefined),
      };
    },
    async unpublishImage(url) {
      await unpublishArtifact({
        conversationId,
        db: getSqlExecutor(),
        ref: url,
      });
    },
  };
}
