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
import { unlinkProvider } from "@/chat/credentials/unlink-provider";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import { createChatSdkLogger, logException, withSpan } from "@/chat/logging";
import { createJuniorGitHubAdapter } from "@/chat/github/adapter";
import { publishAppHomeView } from "@/chat/slack/app-home";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import { getSlackClient } from "@/chat/slack/client";
import { rehydrateAttachmentFetchers } from "@/chat/queue/thread-message-dispatcher";
import { handleSlashCommand } from "@/chat/ingress/slash-command";
import { getStateAdapter } from "@/chat/state/adapter";

type ProductionBot = JuniorChat<Record<string, Adapter>>;

let productionBot: ProductionBot | undefined;
let productionSlackRuntime: ReturnType<typeof createSlackRuntime> | undefined;
let productionGitHubRuntime: ReturnType<typeof createGitHubRuntime> | undefined;

function getAdapterName(thread: { adapter?: { name?: string } }): string | undefined {
  return thread.adapter?.name;
}

function createProductionGitHubAdapter(
  logger: ReturnType<typeof createChatSdkLogger>,
): GitHubAdapter | undefined {
  const appId = getGitHubAppId();
  const privateKey = getGitHubAppPrivateKey();
  const installationId = getGitHubInstallationId();
  const webhookSecret = getGitHubWebhookSecret();
  const botUsername = getGitHubBotUsername();
  const hasAnyGitHubConfig =
    appId !== undefined ||
    privateKey !== undefined ||
    installationId !== undefined ||
    webhookSecret !== undefined ||
    botUsername !== undefined;
  if (!hasAnyGitHubConfig) {
    return undefined;
  }

  const missing: string[] = [];
  if (!appId) missing.push("GITHUB_APP_ID");
  if (!privateKey) missing.push("GITHUB_APP_PRIVATE_KEY");
  if (installationId === undefined) missing.push("GITHUB_INSTALLATION_ID");
  if (!webhookSecret) missing.push("GITHUB_WEBHOOK_SECRET");
  if (!botUsername) missing.push("GITHUB_BOT_USERNAME");
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
    userName: botUsername as string,
  };

  return createJuniorGitHubAdapter({
    ...requiredConfig,
    logger: logger.child("github"),
  });
}

function createProductionBot(): ProductionBot {
  const logger = createChatSdkLogger();
  const githubAdapter = createProductionGitHubAdapter(logger);
  const adapters: Record<string, Adapter> = {
    slack: (() => {
      const signingSecret = getSlackSigningSecret();
      const botToken = getSlackBotToken();
      const clientId = getSlackClientId();
      const clientSecret = getSlackClientSecret();

      if (!signingSecret) {
        throw new Error("SLACK_SIGNING_SECRET is required");
      }

      return createJuniorSlackAdapter({
        logger: logger.child("slack"),
        signingSecret,
        ...(botToken ? { botToken } : {}),
        ...(clientId ? { clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
      });
    })(),
    ...(githubAdapter ? { github: githubAdapter } : {}),
  };

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
  slackRuntime: ReturnType<typeof createSlackRuntime>,
  githubRuntime: ReturnType<typeof createGitHubRuntime>,
): void {
  bot.onNewMention((thread, message) => {
    const adapterName = getAdapterName(thread);
    if (adapterName === "github") {
      return githubRuntime.handleNewMention(thread, message);
    }
    if (adapterName === "slack") {
      rehydrateAttachmentFetchers(message);
      return slackRuntime.handleNewMention(thread, message);
    }
    return;
  });
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

function initializeProductionApp(): void {
  if (productionBot && productionSlackRuntime && productionGitHubRuntime) {
    return;
  }

  const bot = createProductionBot();
  const registerSingleton = (
    bot as unknown as { registerSingleton?: () => unknown }
  ).registerSingleton;
  if (typeof registerSingleton === "function") {
    registerSingleton.call(bot);
  }

  const slackRuntime = createSlackRuntime({
    getSlackAdapter: () => bot.getAdapter("slack") as SlackAdapter,
  });
  const githubRuntime = createGitHubRuntime();

  registerProductionHandlers(bot, slackRuntime, githubRuntime);
  productionBot = bot;
  productionSlackRuntime = slackRuntime;
  productionGitHubRuntime = githubRuntime;
}

/** Return the lazily initialized production chat app. */
export function getProductionBot(): ProductionBot {
  initializeProductionApp();
  return productionBot as ProductionBot;
}
