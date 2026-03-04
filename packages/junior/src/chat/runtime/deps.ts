import { generateAssistantReply as generateAssistantReplyImpl } from "@/chat/respond";
import { completeObject, completeText } from "@/chat/pi/client";
import { listThreadReplies } from "@/chat/slack-actions/channel";
import { downloadPrivateSlackFile } from "@/chat/slack-actions/client";
import { lookupSlackUser } from "@/chat/slack-user";

export interface BotDeps {
  completeObject: typeof completeObject;
  completeText: typeof completeText;
  downloadPrivateSlackFile: typeof downloadPrivateSlackFile;
  generateAssistantReply: typeof generateAssistantReplyImpl;
  listThreadReplies: typeof listThreadReplies;
  lookupSlackUser: typeof lookupSlackUser;
}

const defaultBotDeps: BotDeps = {
  completeObject,
  completeText,
  downloadPrivateSlackFile,
  generateAssistantReply: generateAssistantReplyImpl,
  listThreadReplies,
  lookupSlackUser
};

let botDeps: BotDeps = defaultBotDeps;

export function setBotDepsForTests(overrides: Partial<BotDeps>): void {
  botDeps = {
    ...defaultBotDeps,
    ...overrides
  };
}

export function resetBotDepsForTests(): void {
  botDeps = defaultBotDeps;
}

export function getBotDeps(): BotDeps {
  return botDeps;
}
