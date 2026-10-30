import { serviceAccountOnly } from "@/chat/credentials/service-account";
import { logWarn } from "@/chat/logging";
import { startOAuthFlow } from "@/chat/oauth-flow";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import {
  getSlackToolContext,
  isSlackMessageTurn,
} from "@/chat/slack/tool-support/context";
import type { ToolRuntimeContext } from "@/chat/tools/types";

/**
 * Privately send the Slack actor of this Turn a link to connect one plugin
 * account, without pausing the Turn.
 *
 * Returns false when Junior did not send a link: the Turn did not start from
 * a Slack message, the plugin has no OAuth or uses only its service account,
 * or delivery failed.
 */
export async function requestPluginConnection(
  provider: string,
  context: ToolRuntimeContext,
): Promise<boolean> {
  const manifest = pluginCatalogRuntime.getDefinition(provider)?.manifest;
  if (
    !isSlackMessageTurn(context) ||
    !manifest?.oauth ||
    serviceAccountOnly(manifest)
  ) {
    return false;
  }
  // Omit threadTs like `/jr link`: with a thread and no paused Turn, the
  // OAuth callback posts a public "connected" message in that thread.
  const result = await startOAuthFlow(provider, {
    actorId: context.actor.userId,
    actor: context.actor,
    channelId: getSlackToolContext(context)?.locationChannelId,
    resumeConversationId: context.conversationId,
  });
  if (!result.ok) {
    logWarn("plugin.connection_request.failed", {
      "app.credential.provider": provider,
      "exception.message": result.error,
    });
    return false;
  }
  return result.delivery !== false;
}
