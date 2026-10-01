/**
 * Load earlier turns as stored data before a call.
 *
 * Loading never runs the agent or calls the model. It writes rows with the
 * product functions that turns use: the Conversation store, the turn
 * lifecycle service, agent history commits, and `commitAcceptedReply`. For
 * Slack it also adds the messages to the Slack mock and subscribes the thread
 * when Junior replied in it.
 */
import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { botConfig } from "@/chat/config";
import { appendConversationMessages } from "@/chat/conversations/messages";
import {
  commitAcceptedReply,
  commitMessages,
} from "@/chat/conversations/projection";
import {
  contextProvenance,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";
import { getTurnLifecycle } from "@/chat/conversations/turn-lifecycle";
import {
  recordWebConversationActivity,
  webActorFromEmail,
} from "@/chat/conversations/web-input";
import { renderCurrentInstruction } from "@/chat/current-instruction";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { createSlackDestination } from "@/chat/destination";
import type { PiMessage } from "@/chat/pi/messages";
import { getStateAdapter } from "@/chat/state/adapter";
import {
  coerceThreadConversationState,
  type ConversationMessage,
} from "@/chat/state/conversation";
import {
  buildDeterministicAssistantMessageId,
  buildDeterministicTurnId,
} from "@/chat/state/turn-id";
import type { HistoryItem, HistoryReply, Input } from "./inputs";
import { lastEventSeq, readConversationDetail } from "./results";
import {
  DEFAULT_SLACK_AUTHOR,
  SLACK_BOT_USER_ID,
  SLACK_TEAM_ID,
  type RequestApp,
  type SlackMock,
} from "./slack";

/** The web person whose dashboard messages the fixture sends. */
export const WEB_VIEWER_EMAIL = "alice@example.com";

export type LoadedConversation =
  | { conversationId: string; surface: "web" }
  | {
      channelId: string;
      channelType: "channel" | "im";
      conversationId: string;
      surface: "slack";
      threadTs: string;
    };

interface HistoryTurn {
  input: Input;
  replies: HistoryReply[];
}

function groupTurns(items: HistoryItem[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  for (const item of items) {
    if (item.kind === "reply") {
      const turn = turns.at(-1);
      if (!turn) throw new Error("history must start with an input");
      turn.replies.push(item);
      continue;
    }
    turns.push({ input: item, replies: [] });
  }
  return turns;
}

async function recordRoot(conversation: LoadedConversation, nowMs: number) {
  if (conversation.surface === "web") {
    await recordWebConversationActivity({
      actor: webActorFromEmail(WEB_VIEWER_EMAIL),
      conversationId: conversation.conversationId,
      nowMs,
    });
    return;
  }
  const destination = createSlackDestination({
    channelId: conversation.channelId,
    teamId: SLACK_TEAM_ID,
  });
  await getConversationStore().recordActivity({
    conversationId: conversation.conversationId,
    destination,
    nowMs,
    sessionSource: createSlackSource({
      channelId: conversation.channelId,
      teamId: SLACK_TEAM_ID,
      threadTs: conversation.threadTs,
      visibility: "public",
    }),
    source: "slack",
    visibility: "public",
  });
}

function assistantPiMessage(text: string, timestamp: number): AssistantMessage {
  const modelId =
    botConfig.profiles[botConfig.defaultProfile]?.modelId ?? "history";
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    model: modelId,
    stopReason: "stop",
    timestamp,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

/** Write `items` as earlier turns. Return the last event sequence. */
export async function loadHistory(args: {
  api: RequestApp;
  conversation: LoadedConversation;
  items: HistoryItem[];
  replyMessages: WeakMap<HistoryReply, string>;
  slack: SlackMock;
  viewerEmail: string;
}): Promise<number> {
  const { conversation } = args;
  const conversationId = conversation.conversationId;
  const turns = groupTurns(args.items);
  // Earlier turns happened before the call, one millisecond apart.
  let clockMs = Date.now() - args.items.length - 1;
  const tick = () => (clockMs += 1);
  await recordRoot(conversation, tick());
  const lifecycle = getTurnLifecycle();
  const state = coerceThreadConversationState({});
  const webActor = webActorFromEmail(WEB_VIEWER_EMAIL);
  const agentHistory: PiMessage[] = [];
  const agentProvenance: ConversationMessageProvenance[] = [];

  for (const [index, turn] of turns.entries()) {
    const input = turn.input;
    const createdAtMs = tick();
    const isSlack = conversation.surface === "slack";
    if (isSlack && input.kind === "web_message") {
      throw new Error("Slack history needs Slack inputs");
    }
    if (!isSlack && input.kind !== "web_message") {
      throw new Error("Web history needs webMessage() inputs");
    }
    const author = args.slack.registerAuthor(
      input.kind === "web_message"
        ? DEFAULT_SLACK_AUTHOR
        : (input.author ?? DEFAULT_SLACK_AUTHOR),
    );
    // A Slack thread root uses the thread timestamp.
    const messageId =
      conversation.surface === "slack"
        ? index === 0
          ? conversation.threadTs
          : args.slack.nextTs()
        : `history-${randomUUID()}`;
    const turnId = buildDeterministicTurnId(messageId);
    const explicitMention = input.kind === "mention";
    const text =
      conversation.surface === "slack" && explicitMention
        ? `<@${SLACK_BOT_USER_ID}> ${input.text}`
        : input.text;
    if (conversation.surface === "slack") {
      args.slack.addThreadMessage(conversation.channelId, {
        text,
        thread_ts: conversation.threadTs,
        ts: messageId,
        user: author.userId,
      });
    }

    await lifecycle.start({
      conversationId,
      createdAtMs,
      inputMessageIds: [messageId],
      surface: isSlack ? "slack" : "api",
      turnId,
    });
    const userMessage: ConversationMessage = isSlack
      ? {
          author: {
            fullName: author.fullName,
            isBot: false,
            userId: author.userId,
            userName: author.userName,
          },
          createdAtMs,
          id: messageId,
          meta: {
            explicitMention,
            replied: turn.replies.length > 0,
            slackTs: messageId,
            source: "slack",
          },
          role: "user",
          text: input.text,
        }
      : {
          author: {
            ...(webActor.fullName ? { fullName: webActor.fullName } : {}),
            isBot: false,
            userId: webActor.userId,
          },
          createdAtMs,
          id: messageId,
          meta: { replied: turn.replies.length > 0, source: "web" },
          role: "user",
          text: input.text,
        };
    state.messages.push(userMessage);
    await appendConversationMessages(getConversationEventStore(), {
      conversation: state,
      conversationId,
      repliedAtMs: createdAtMs,
    });
    const actor = isSlack
      ? {
          platform: "slack" as const,
          teamId: SLACK_TEAM_ID,
          userId: author.userId,
        }
      : webActor;
    // Agent history commits take the full history, not only new messages.
    agentHistory.push({
      role: "user",
      content: [
        {
          type: "text",
          text: renderCurrentInstruction(input.text, {
            authorId: author.userId,
            authorName: author.fullName,
            ...(isSlack ? { slackTs: messageId } : undefined),
          }),
        },
      ],
      timestamp: createdAtMs,
    } satisfies PiMessage);
    agentProvenance.push({ authority: "instruction", actor });
    await commitMessages({
      conversationId,
      messages: agentHistory,
      provenance: agentProvenance,
    });

    for (const [replyIndex, historyReply] of turn.replies.entries()) {
      const repliedAtMs = tick();
      if (historyReply.toolHistory?.length) {
        for (const message of historyReply.toolHistory) {
          agentHistory.push({ ...message, timestamp: repliedAtMs });
          agentProvenance.push(contextProvenance);
        }
        await commitMessages({
          conversationId,
          messages: agentHistory,
          provenance: agentProvenance,
        });
      }
      const replyId =
        replyIndex === 0
          ? buildDeterministicAssistantMessageId(turnId)
          : `${turnId}:assistant:${replyIndex + 1}`;
      state.messages.push({
        author: {
          isBot: true,
          userId: SLACK_BOT_USER_ID,
          userName: botConfig.userName,
        },
        createdAtMs: repliedAtMs,
        id: replyId,
        meta: { source: isSlack ? "slack" : "web" },
        role: "assistant",
        text: historyReply.text,
      });
      const agentMessage = assistantPiMessage(historyReply.text, repliedAtMs);
      agentHistory.push(agentMessage);
      agentProvenance.push(contextProvenance);
      await commitAcceptedReply({
        agentMessage,
        conversation: state,
        conversationId,
        conversationMessageId: replyId,
        repliedAtMs,
      });
      args.replyMessages.set(historyReply, replyId);
      if (conversation.surface === "slack") {
        args.slack.addThreadMessage(conversation.channelId, {
          bot_id: "B_TEST_BOT",
          text: historyReply.text,
          thread_ts: conversation.threadTs,
          user: SLACK_BOT_USER_ID,
        });
      }
    }
    await lifecycle.complete({
      conversationId,
      createdAtMs: tick(),
      outcome: turn.replies.length > 0 ? "success" : "no_reply",
      turnId,
    });
  }

  if (
    conversation.surface === "slack" &&
    turns.some((turn) => turn.replies.length > 0)
  ) {
    // A thread Junior replied in stays subscribed for follow-ups.
    await getStateAdapter().subscribe(conversationId);
  }
  return lastEventSeq(
    await readConversationDetail(args.api, conversationId, args.viewerEmail),
  );
}
