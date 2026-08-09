import type { Message, Thread } from "chat";
import type { Destination } from "@sentry/junior-plugin-api";
import type { DestinationConfigurationService } from "@/chat/configuration/types";

export interface TurnContext {
  channelId?: string;
  actorId?: string;
  threadId?: string;
  runId?: string;
}

export interface TurnMessageText {
  rawText: string;
  userText: string;
}

export interface TurnToolInvocation {
  params: Record<string, unknown>;
  toolName: string;
}

export interface QueuedTurnMessage extends TurnMessageText {
  explicitMention: boolean;
  message: Message;
}

export interface PrepareTurnStateInput {
  destination: Destination;
  destinationConfiguration?: DestinationConfigurationService;
  context: TurnContext;
  explicitMention: boolean;
  message: Message;
  queuedMessages?: QueuedTurnMessage[];
  skipBackfill?: boolean;
  text: TurnMessageText;
  thread: Thread;
}

function combineTextParts(queuedTexts: readonly string[], latestText: string) {
  const parts = [...queuedTexts, latestText].filter(
    (part) => part.trim().length > 0,
  );
  return parts.length > 0 ? parts.join("\n\n") : latestText;
}

/** Preserve skipped Slack messages as turn input without duplicating stored state. */
export function combineTurnText(
  queuedMessages: readonly TurnMessageText[],
  latestText: TurnMessageText,
): TurnMessageText {
  return {
    rawText: combineTextParts(
      queuedMessages.map((message) => message.rawText),
      latestText.rawText,
    ),
    userText: combineTextParts(
      queuedMessages.map((message) => message.userText),
      latestText.userText,
    ),
  };
}
