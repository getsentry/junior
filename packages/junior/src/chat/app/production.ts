import type { SlackAdapter } from "@chat-adapter/slack";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createSlackRuntime } from "@/chat/app/factory";
import { registerBotHandlers } from "@/chat/bootstrap/register-handlers";
import {
  botConfig,
  getSlackBotToken,
  getSlackClientId,
  getSlackClientSecret,
  getSlackSigningSecret,
} from "@/chat/config";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import { createNormalizingStream } from "@/chat/runtime/streaming";
import { getStateAdapter } from "@/chat/state/adapter";

export const bot = new JuniorChat<{ slack: SlackAdapter }>({
  userName: botConfig.userName,
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

const registerSingleton = (
  bot as unknown as { registerSingleton?: () => unknown }
).registerSingleton;
if (typeof registerSingleton === "function") {
  registerSingleton.call(bot);
}

function getSlackAdapter(): SlackAdapter {
  return bot.getAdapter("slack");
}

export const slackRuntime = createSlackRuntime({
  getSlackAdapter,
});

registerBotHandlers({
  bot,
  runtime: slackRuntime,
});

export { createNormalizingStream };
