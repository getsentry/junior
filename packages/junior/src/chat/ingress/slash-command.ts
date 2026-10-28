import type { Channel } from "chat";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { unlinkProvider } from "@/chat/credentials/unlink-provider";
import { formatProviderLabel, startOAuthFlow } from "@/chat/oauth-flow";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { logInfo } from "@/chat/logging";
import { getChatConfig } from "@/chat/config";
import type {
  SlackChannelId,
  SlackTeamId,
  SlackUserId,
} from "@/chat/slack/ids";

type SlackSlashCommand = {
  text: string;
  userId: SlackUserId;
  channel: Pick<Channel, "postEphemeral">;
  teamId: SlackTeamId;
  channelId: SlackChannelId;
};

async function postEphemeral(
  event: SlackSlashCommand,
  text: string,
): Promise<void> {
  await event.channel.postEphemeral(event.userId, text, {
    fallbackToDM: false,
  });
}

function getCommandName(): string {
  return getChatConfig().slack.slashCommand;
}

async function handleLink(
  event: SlackSlashCommand,
  provider: string,
): Promise<void> {
  if (!pluginCatalogRuntime.isProvider(provider)) {
    await postEphemeral(event, `Unknown provider: \`${provider}\``);
    return;
  }

  if (!pluginCatalogRuntime.getOAuthConfig(provider)) {
    await postEphemeral(
      event,
      `${formatProviderLabel(provider)} doesn't support account linking.`,
    );
    return;
  }

  const result = await startOAuthFlow(provider, {
    actorId: event.userId,
    actor: { platform: "slack", teamId: event.teamId, userId: event.userId },
    channelId: event.channelId,
  });

  if (!result.ok) {
    await postEphemeral(event, `Failed to start linking: ${result.error}`);
    return;
  }

  if (result.delivery === "fallback_dm") {
    await postEphemeral(
      event,
      `Check your DMs for a ${formatProviderLabel(provider)} authorization link.`,
    );
  } else if (result.delivery === false) {
    await postEphemeral(
      event,
      "I wasn't able to send you a private authorization link. Please try again in a direct message.",
    );
  }
}

async function handleUnlink(
  event: SlackSlashCommand,
  provider: string,
): Promise<void> {
  if (!pluginCatalogRuntime.isProvider(provider)) {
    await postEphemeral(event, `Unknown provider: \`${provider}\``);
    return;
  }

  const supportsUnlink =
    Boolean(pluginCatalogRuntime.getOAuthConfig(provider)) ||
    Boolean(pluginCatalogRuntime.getDefinition(provider)?.manifest.mcp);
  if (!supportsUnlink) {
    await postEphemeral(
      event,
      `${formatProviderLabel(provider)} doesn't support account unlinking.`,
    );
    return;
  }

  const tokenStore = createUserTokenStore();
  await unlinkProvider(event.userId, provider, tokenStore, event.teamId);

  logInfo("slash_command.credential.unlinked", {
    "app.credential.provider": provider,
  });

  await postEphemeral(
    event,
    `Your ${formatProviderLabel(provider)} account has been unlinked.`,
  );
}

/** Route link and unlink slash commands to the appropriate OAuth flow. */
export async function handleSlashCommand(
  event: SlackSlashCommand,
): Promise<void> {
  const [subcommand, provider, ...rest] = event.text.trim().split(/\s+/);

  if (!subcommand || !["link", "unlink"].includes(subcommand)) {
    await postEphemeral(
      event,
      `Usage: \`${getCommandName()} link <provider>\` or \`${getCommandName()} unlink <provider>\``,
    );
    return;
  }

  if (!provider || rest.length > 0) {
    await postEphemeral(
      event,
      `Usage: \`${getCommandName()} ${subcommand} <provider>\``,
    );
    return;
  }

  const normalized = provider.toLowerCase();

  if (subcommand === "link") {
    await handleLink(event, normalized);
  } else {
    await handleUnlink(event, normalized);
  }
}
