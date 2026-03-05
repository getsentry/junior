import type { WebClient, KnownBlock, SectionBlock } from "@slack/web-api";
import { logInfo } from "@/chat/observability";
import { getPluginProviders } from "@/chat/plugins/registry";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { getRuntimeMetadata } from "@/chat/runtime-metadata";

interface HomeView {
  type: "home";
  blocks: KnownBlock[];
}

export async function buildHomeView(
  userId: string,
  userTokenStore: UserTokenStore
): Promise<HomeView> {
  const runtimeMetadata = getRuntimeMetadata();
  const providers = getPluginProviders();
  const connectedSections: SectionBlock[] = [];
  const versionSection: SectionBlock = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*junior version:* \`${runtimeMetadata.version ?? "unknown"}\``
    }
  };

  for (const plugin of providers) {
    if (plugin.manifest.credentials.type !== "oauth-bearer") continue;

    const tokens = await userTokenStore.get(userId, plugin.manifest.name);
    if (!tokens) continue;

    connectedSections.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${plugin.manifest.name}*\n${plugin.manifest.description}`
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Unlink" },
        action_id: "app_home_disconnect",
        value: plugin.manifest.name,
        style: "danger"
      }
    });
  }

  if (connectedSections.length === 0) {
    return {
      type: "home",
      blocks: [
        versionSection,
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "No connected accounts"
          }
        }
      ]
    };
  }

  return {
    type: "home",
    blocks: [versionSection, ...connectedSections]
  };
}

export async function publishAppHomeView(
  slackClient: WebClient,
  userId: string,
  userTokenStore: UserTokenStore
): Promise<void> {
  const view = await buildHomeView(userId, userTokenStore);
  await slackClient.views.publish({ user_id: userId, view });
  logInfo("app_home_published", {}, { "app.user_id": userId });
}
