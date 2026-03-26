import type { SlackAdapter } from "@chat-adapter/slack";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createSlackRuntime } from "@/chat/app/factory";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import {
  botConfig,
  getSlackBotToken,
  getSlackClientId,
  getSlackClientSecret,
  getSlackSigningSecret,
} from "@/chat/config";
import { unlinkProvider } from "@/chat/credentials/unlink-provider";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import { logException, withSpan } from "@/chat/logging";
import { downloadPrivateSlackFile } from "@/chat/slack/client";
import { publishAppHomeView } from "@/chat/slack/app-home";
import { getSlackClient } from "@/chat/slack/client";
import { handleSlashCommand } from "@/chat/ingress/slash-command";
import { createNormalizingStream } from "@/chat/runtime/streaming";
import { getStateAdapter } from "@/chat/state/adapter";

let productionBot: JuniorChat<{ slack: SlackAdapter }> | undefined;
let productionSlackRuntime: ReturnType<typeof createSlackRuntime> | undefined;

function createProductionBot(): JuniorChat<{ slack: SlackAdapter }> {
  return new JuniorChat<{ slack: SlackAdapter }>({
    userName: botConfig.userName,
    concurrency: "queue",
    adapters: {
      slack: (() => {
        const signingSecret = getSlackSigningSecret();
        const botToken = getSlackBotToken();
        const clientId = getSlackClientId();
        const clientSecret = getSlackClientSecret();

        if (!signingSecret) {
          throw new Error("SLACK_SIGNING_SECRET is required");
        }

        return createSlackAdapter({
          signingSecret,
          ...(botToken ? { botToken } : {}),
          ...(clientId ? { clientId } : {}),
          ...(clientSecret ? { clientSecret } : {}),
        });
      })(),
    },
    state: getStateAdapter(),
  });
}

/**
 * Attach Slack private-file download functions to deserialized attachments.
 *
 * The Chat SDK's `concurrency: "queue"` strategy serializes queued messages
 * via `Message.toJSON()`, which intentionally strips `fetchData` (a function)
 * and `data` (a Buffer) since they aren't JSON-serializable. See
 * chat/dist/index.js around line 306. When the SDK later dequeues and
 * dispatches the message, attachments have a `url` but no way to fetch the
 * bytes — Slack private file URLs require a bot-token auth'd download.
 *
 * This only affects messages that were queued (i.e. arrived while another
 * handler was running). Direct-dispatch messages retain their original
 * fetchData. Calling this unconditionally is safe because it no-ops when
 * fetchData is already present.
 *
 * Remove this when the Chat SDK preserves fetchData across queue
 * serialization, or provides a hook for rehydrating attachments on dequeue.
 */
function rehydrateAttachments(message: {
  attachments: Array<{ fetchData?: unknown; url?: string }>;
}): void {
  for (const attachment of message.attachments) {
    if (!attachment.fetchData && attachment.url) {
      const url = attachment.url;
      attachment.fetchData = () => downloadPrivateSlackFile(url);
    }
  }
}

function registerProductionHandlers(
  bot: JuniorChat<{ slack: SlackAdapter }>,
  slackRuntime: ReturnType<typeof createSlackRuntime>,
): void {
  bot.onNewMention((thread, message) => {
    rehydrateAttachments(message);
    return slackRuntime.handleNewMention(thread, message);
  });
  bot.onSubscribedMessage((thread, message) => {
    rehydrateAttachments(message);
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
  if (productionBot && productionSlackRuntime) {
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
    getSlackAdapter: () => bot.getAdapter("slack"),
  });

  registerProductionHandlers(bot, slackRuntime);
  productionBot = bot;
  productionSlackRuntime = slackRuntime;
}

/** Return the lazily initialized production chat app. */
export function getProductionBot(): JuniorChat<{ slack: SlackAdapter }> {
  initializeProductionApp();
  return productionBot as JuniorChat<{ slack: SlackAdapter }>;
}

/** Return the lazily initialized production Slack turn runtime. */
export function getProductionSlackRuntime(): ReturnType<
  typeof createSlackRuntime
> {
  initializeProductionApp();
  return productionSlackRuntime as ReturnType<typeof createSlackRuntime>;
}

export { createNormalizingStream };
