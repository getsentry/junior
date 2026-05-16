import type { GitHubAdapter } from "@chat-adapter/github";
import type { SlackAdapter } from "@chat-adapter/slack";
import type { Adapter } from "chat";
import { createGitHubRuntime, createSlackRuntime } from "@/chat/app/factory";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import {
  botConfig,
  getGitHubAppId,
  getGitHubAppPrivateKey,
  getGitHubBotUsername,
  getGitHubInstallationId,
  getGitHubWebhookSecret,
  getSlackBotToken,
  getSlackClientId,
  getSlackClientSecret,
  getSlackSigningSecret,
} from "@/chat/config";
import {
  resolveEnabledChatPlatforms,
  type ChatPlatform,
} from "@/chat/platforms";
import { unlinkProvider } from "@/chat/credentials/unlink-provider";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import { createChatSdkLogger, logException, withSpan } from "@/chat/logging";
import { createJuniorGitHubAdapter } from "@/chat/github/adapter";
import { normalizeGitHubMentionTarget } from "@/chat/github/mention";
import { publishAppHomeView } from "@/chat/slack/app-home";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import { getSlackClient } from "@/chat/slack/client";
import { rehydrateAttachmentFetchers } from "@/chat/queue/thread-message-dispatcher";
import { handleSlashCommand } from "@/chat/ingress/slash-command";
import { getStateAdapter } from "@/chat/state/adapter";

export type ProductionBot = JuniorChat<Record<string, Adapter>>;

function getAdapterName(thread: {
  adapter?: { name?: string };
}): string | undefined {
  return thread.adapter?.name;
}

function createProductionSlackAdapter(
  logger: ReturnType<typeof createChatSdkLogger>,
): SlackAdapter {
  const signingSecret = getSlackSigningSecret();
  const botToken = getSlackBotToken();
  const clientId = getSlackClientId();
  const clientSecret = getSlackClientSecret();

  if (!signingSecret) {
    throw new Error("SLACK_SIGNING_SECRET is required when Slack is enabled");
  }

  return createJuniorSlackAdapter({
    logger: logger.child("slack"),
    signingSecret,
    ...(botToken ? { botToken } : {}),
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
  });
}

function createProductionGitHubAdapter(
  logger: ReturnType<typeof createChatSdkLogger>,
): GitHubAdapter {
  const appId = getGitHubAppId();
  const privateKey = getGitHubAppPrivateKey();
  const installationId = getGitHubInstallationId();
  const webhookSecret = getGitHubWebhookSecret();
  const botUsername = getGitHubBotUsername();
  const mentionTarget = botUsername
    ? normalizeGitHubMentionTarget(botUsername)
    : undefined;

  const missing: string[] = [];
  if (!appId) missing.push("GITHUB_APP_ID");
  if (!privateKey) missing.push("GITHUB_APP_PRIVATE_KEY");
  if (installationId === undefined) missing.push("GITHUB_INSTALLATION_ID");
  if (!webhookSecret) missing.push("GITHUB_WEBHOOK_SECRET");
  if (!mentionTarget) missing.push("GITHUB_BOT_USERNAME");
  if (missing.length > 0) {
    throw new Error(
      `GitHub adapter requires ${missing.join(", ")} when GitHub webhook support is enabled`,
    );
  }

  const requiredConfig = {
    appId: appId as string,
    privateKey: privateKey as string,
    installationId: installationId as number,
    webhookSecret: webhookSecret as string,
    userName: mentionTarget as string,
  };

  return createJuniorGitHubAdapter({
    ...requiredConfig,
    logger: logger.child("github"),
  });
}

function includesPlatform(
  enabledPlatforms: readonly ChatPlatform[],
  platform: ChatPlatform,
): boolean {
  return enabledPlatforms.includes(platform);
}

function createProductionBot(
  enabledPlatforms: readonly ChatPlatform[],
): ProductionBot {
  const logger = createChatSdkLogger();
  const adapters: Record<string, Adapter> = {};
  if (includesPlatform(enabledPlatforms, "slack")) {
    adapters.slack = createProductionSlackAdapter(logger);
  }
  if (includesPlatform(enabledPlatforms, "github")) {
    adapters.github = createProductionGitHubAdapter(logger);
  }
  if (Object.keys(adapters).length === 0) {
    throw new Error("At least one chat platform must be enabled");
  }

  return new JuniorChat<Record<string, Adapter>>({
    userName: botConfig.userName,
    logger,
    concurrency: {
      strategy: "queue",
      // The SDK's default queueEntryTtlMs is 90s, but Junior turns can
      // run up to botConfig.turnTimeoutMs (default 12min). A follow-up
      // message that arrives during a long turn would expire in the
      // queue before the lock is released. Set the TTL to exceed the
      // maximum turn duration so queued messages survive.
      queueEntryTtlMs: botConfig.turnTimeoutMs + 60_000,
    },
    adapters,
    state: getStateAdapter(),
  });
}

// Timeout turns checkpoint and schedule an internal continuation when
// they hit a safe boundary. MCP auth pauses remain retryable too,
// resumed via the OAuth callback path.
function registerProductionHandlers(
  bot: ProductionBot,
  runtimes: {
    github?: ReturnType<typeof createGitHubRuntime>;
    slack?: ReturnType<typeof createSlackRuntime>;
  },
): void {
  bot.onNewMention((thread, message) => {
    const adapterName = getAdapterName(thread);
    if (adapterName === "github" && runtimes.github) {
      return runtimes.github.handleNewMention(thread, message);
    }
    if (adapterName === "slack" && runtimes.slack) {
      rehydrateAttachmentFetchers(message);
      return runtimes.slack.handleNewMention(thread, message);
    }
    return;
  });
  if (!runtimes.slack) {
    return;
  }
  const slackRuntime = runtimes.slack;

  // Route DMs through the mention handler so every DM gets a reply.
  // Without this, the SDK routes DMs in subscribed threads to
  // onSubscribedMessage (Chat.dispatchToHandlers checks isSubscribed
  // before isDM), where the reply-policy classifier can decide to
  // stay silent — wrong for 1:1 conversations. onDirectMessage is
  // checked first (Chat.dispatchToHandlers:3128), bypassing the
  // subscription branch entirely.
  bot.onDirectMessage((thread, message) => {
    if (getAdapterName(thread) !== "slack") {
      return;
    }
    rehydrateAttachmentFetchers(message);
    return slackRuntime.handleNewMention(thread, message);
  });
  bot.onSubscribedMessage((thread, message) => {
    if (getAdapterName(thread) !== "slack") {
      return;
    }
    rehydrateAttachmentFetchers(message);
    return slackRuntime.handleSubscribedMessage(thread, message);
  });
  bot.onAssistantThreadStarted((event) =>
    slackRuntime.handleAssistantThreadStarted(event),
  );
  bot.onAssistantContextChanged((event) =>
    slackRuntime.handleAssistantContextChanged(event),
  );

  bot.onSlashCommand("/jr", (event) =>
    withSpan(
      "chat.slash_command",
      "chat.slash_command",
      { slackUserId: event.user.userId },
      async () => {
        try {
          await handleSlashCommand(event);
        } catch (error) {
          logException(error, "slash_command_failed", {
            slackUserId: event.user.userId,
          });
          throw error;
        }
      },
    ),
  );

  bot.onAppHomeOpened((event) =>
    withSpan(
      "chat.app_home_opened",
      "chat.app_home_opened",
      { slackUserId: event.userId },
      async () => {
        try {
          await publishAppHomeView(
            getSlackClient(),
            event.userId,
            createUserTokenStore(),
          );
        } catch (error) {
          logException(error, "app_home_opened_failed", {
            slackUserId: event.userId,
          });
        }
      },
    ),
  );

  bot.onAction("app_home_disconnect", async (event) => {
    const provider = event.value;
    if (!provider) return;
    const userId = event.user.userId;
    await withSpan(
      "chat.app_home_disconnect",
      "chat.app_home_disconnect",
      { slackUserId: userId },
      async () => {
        try {
          await unlinkProvider(userId, provider, createUserTokenStore());
          await publishAppHomeView(
            getSlackClient(),
            userId,
            createUserTokenStore(),
          );
        } catch (error) {
          logException(
            error,
            "app_home_disconnect_failed",
            { slackUserId: userId },
            {
              "app.credential.provider": provider,
            },
          );
        }
      },
    );
  });
}

export interface ProductionBotOptions {
  enabledPlatforms?: readonly ChatPlatform[];
}

/** Create an app-scoped lazy production bot resolver. */
export function createProductionBotResolver(
  options: ProductionBotOptions = {},
): () => ProductionBot {
  const enabledPlatforms = resolveEnabledChatPlatforms(
    options.enabledPlatforms,
    "enabledPlatforms",
  );
  let productionBot: ProductionBot | undefined;

  return () => {
    if (productionBot) {
      return productionBot;
    }

    const bot = createProductionBot(enabledPlatforms);
    const registerSingleton = (
      bot as unknown as { registerSingleton?: () => unknown }
    ).registerSingleton;
    if (typeof registerSingleton === "function") {
      registerSingleton.call(bot);
    }

    const slackRuntime = includesPlatform(enabledPlatforms, "slack")
      ? createSlackRuntime({
          getSlackAdapter: () => bot.getAdapter("slack") as SlackAdapter,
        })
      : undefined;
    const githubRuntime = includesPlatform(enabledPlatforms, "github")
      ? createGitHubRuntime()
      : undefined;

    registerProductionHandlers(bot, {
      github: githubRuntime,
      slack: slackRuntime,
    });
    productionBot = bot;
    return bot;
  };
}
