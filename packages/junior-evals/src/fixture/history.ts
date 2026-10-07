/**
 * Load earlier turns as stored data before a call.
 *
 * Loading never runs the agent or calls the model. It writes rows with the
 * product functions that turns use: the Conversation store, the turn
 * lifecycle service, agent history commits, and `commitAcceptedReply`. For
 * Slack it also adds the messages to the Slack mock and subscribes the thread
 * when Junior replied in it. A message from another app is in the Slack mock
 * only.
 */
import { randomUUID } from "node:crypto";
import { SlackFormatConverter } from "@chat-adapter/slack";
import type {
  AssistantMessage,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
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
import { NO_REPLY_MARKER } from "@/chat/no-reply";
import { createSlackDestination } from "@/chat/destination";
import { conversationVisibilityFromSlackChannelType } from "@/chat/slack/conversation-context";
import { parseContent } from "@/chat/slack/message/content";
import type { PiMessage } from "@/chat/pi/messages";
import { getStateAdapter } from "@/chat/state/adapter";
import { makeStructuredToolOutput } from "@/chat/tool-support/structured-result";
import {
  coerceThreadConversationState,
  type ConversationMessage,
} from "@/chat/state/conversation";
import {
  buildDeterministicAssistantMessageId,
  buildDeterministicTurnId,
} from "@/chat/state/turn-id";
import type {
  AppMessage,
  HistoryItem,
  HistoryReply,
  HistoryToolCall,
  MessageInput,
} from "./inputs";
import {
  insertRecordedEvents,
  isRecordedConversation,
  recordedMessages,
  type RecordedConversation,
} from "./recorded";
import {
  BEFORE_FIRST_EVENT,
  lastEventSeq,
  readConversationDetail,
} from "./results";
import {
  DEFAULT_SLACK_AUTHOR,
  SLACK_APP,
  SLACK_APP_BOT_ID,
  SLACK_BOT_USER_ID,
  SLACK_TEAM_ID,
  type RequestApp,
  appMessageContent,
  isAppMention,
  slackAuthorEmail,
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
  input: MessageInput;
  replies: HistoryReply[];
}

function groupTurns(items: HistoryItem[]): {
  appMessages: AppMessage[];
  turns: HistoryTurn[];
} {
  const appMessages: AppMessage[] = [];
  const turns: HistoryTurn[] = [];
  for (const item of items) {
    if (item.kind === "app_message") {
      // Junior stores a message that arrives after it joined the thread.
      if (turns.length > 0) {
        throw new Error("appMessage() comes before the first input");
      }
      appMessages.push(item);
      continue;
    }
    if (item.kind === "reply") {
      const turn = turns.at(-1);
      if (!turn) throw new Error("history must start with an input");
      turn.replies.push(item);
      continue;
    }
    // A real turn stores what it read from a file. History has no such data.
    const files = item.kind === "web_message" ? item.images : item.files;
    if (files?.length) {
      throw new Error("history takes no files; send the file in a call");
    }
    // A real turn stores the text that it read from a forwarded message.
    if (item.kind !== "web_message" && item.forwarded) {
      throw new Error(
        "history takes no forwarded message; send the input in a call",
      );
    }
    turns.push({ input: item, replies: [] });
  }
  return { appMessages, turns };
}

/**
 * The visibility a real Slack turn learns from its input event. An
 * `app_mention` has no channel type, so the turn learns nothing.
 */
function slackInputVisibility(
  conversation: Extract<LoadedConversation, { surface: "slack" }>,
  input: MessageInput,
) {
  return conversationVisibilityFromSlackChannelType(
    isAppMention(input, conversation.channelType)
      ? undefined
      : conversation.channelType,
  );
}

async function recordRoot(
  conversation: LoadedConversation,
  nowMs: number,
  firstInput?: MessageInput,
) {
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
  const visibility = firstInput
    ? slackInputVisibility(conversation, firstInput)
    : undefined;
  await getConversationStore().recordActivity({
    conversationId: conversation.conversationId,
    destination,
    nowMs,
    sessionSource: createSlackSource({
      channelId: conversation.channelId,
      teamId: SLACK_TEAM_ID,
      threadTs: conversation.threadTs,
      visibility: visibility ?? "private",
    }),
    source: "slack",
    ...(visibility ? { visibility } : undefined),
  });
}

function assistantPiMessage(
  content: AssistantMessage["content"],
  timestamp: number,
): AssistantMessage {
  const modelId =
    botConfig.profiles[botConfig.defaultProfile]?.modelId ?? "history";
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    model: modelId,
    stopReason: content.some((part) => part.type === "toolCall")
      ? "toolUse"
      : "stop",
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

/** The model request and the tool output of one completed tool call. */
function toolCallPiMessages(
  call: HistoryToolCall,
  timestamp: number,
): [AssistantMessage, ToolResultMessage] {
  const toolCallId = `history-${randomUUID()}`;
  const output = makeStructuredToolOutput(call.result);
  return [
    assistantPiMessage(
      [
        {
          type: "toolCall",
          id: toolCallId,
          name: call.name,
          arguments: call.arguments,
        },
      ],
      timestamp,
    ),
    {
      role: "toolResult",
      toolCallId,
      toolName: call.name,
      content: output.content,
      details: output.details,
      isError: false,
      timestamp,
    },
  ];
}

/** Return whether a call loads any history. */
export function hasHistory(
  history: HistoryItem[] | RecordedConversation | undefined,
): history is HistoryItem[] | RecordedConversation {
  return isRecordedConversation(history)
    ? history.events.length > 0
    : Boolean(history?.length);
}

/** Insert a recording as a fork copies rows, then mirror it into Slack. */
async function loadRecording(args: {
  api: RequestApp;
  conversation: LoadedConversation;
  recording: RecordedConversation;
  slack: SlackMock;
  viewerEmail: string;
}): Promise<number> {
  const { conversation, recording } = args;
  if (recording.surface !== conversation.surface) {
    throw new Error(
      `A ${recording.surface} recording needs a ${recording.surface} input`,
    );
  }
  await recordRoot(conversation, Date.now());
  await insertRecordedEvents(conversation.conversationId, recording);
  if (conversation.surface === "slack") {
    const messages = recordedMessages(recording);
    for (const [index, message] of messages.entries()) {
      args.slack.addThreadMessage(conversation.channelId, {
        text: message.text,
        thread_ts: conversation.threadTs,
        ...(index === 0 ? { ts: conversation.threadTs } : undefined),
        user:
          message.role === "assistant"
            ? SLACK_BOT_USER_ID
            : DEFAULT_SLACK_AUTHOR.userId,
      });
    }
    if (messages.some((message) => message.role === "assistant")) {
      await getStateAdapter().subscribe(conversation.conversationId);
    }
  }
  return lastEventSeq(
    await readConversationDetail(
      args.api,
      conversation.conversationId,
      args.viewerEmail,
    ),
  );
}

/** One user input as a turn stores it: visible message, agent input, actor. */
function historyUserMessage(args: {
  conversation: LoadedConversation;
  createdAtMs: number;
  /** The first Slack message is the thread root. */
  first: boolean;
  input: MessageInput;
  slack: SlackMock;
}): {
  actor: ConversationMessageProvenance["actor"];
  agentMessage: PiMessage;
  conversationMessage: ConversationMessage;
} {
  const { conversation, input } = args;
  if (conversation.surface === "web") {
    if (input.kind !== "web_message") {
      throw new Error("Web history needs webMessage() inputs");
    }
    const actor = webActorFromEmail(WEB_VIEWER_EMAIL, {
      userName: WEB_VIEWER_EMAIL.split("@")[0],
    });
    return {
      actor,
      agentMessage: {
        role: "user",
        content: [{ type: "text", text: renderCurrentInstruction(input.text) }],
        timestamp: args.createdAtMs,
      },
      conversationMessage: {
        author: {
          email: actor.email,
          userId: actor.userId,
          userName: actor.userName,
        },
        createdAtMs: args.createdAtMs,
        id: `api-msg:${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        meta: { explicitMention: true, source: "web" },
        role: "user",
        text: input.text,
      },
    };
  }
  if (input.kind === "web_message") {
    throw new Error("Slack history needs Slack inputs");
  }
  const author = args.slack.registerAuthor(
    input.author ?? DEFAULT_SLACK_AUTHOR,
  );
  const text = slackInputText(input.text);
  // Junior routes every direct message like a mention. Only an app_mention
  // carries the @Junior token in its text.
  const explicitMention =
    input.kind === "mention" || conversation.channelType === "im";
  const ts = args.slack.addThreadMessage(conversation.channelId, {
    text: isAppMention(input, conversation.channelType)
      ? `<@${SLACK_BOT_USER_ID}> ${input.text}`
      : input.text,
    thread_ts: conversation.threadTs,
    ...(args.first ? { ts: conversation.threadTs } : undefined),
    user: author.userId,
  });
  return {
    actor: {
      email: slackAuthorEmail(author),
      fullName: author.fullName,
      platform: "slack",
      teamId: SLACK_TEAM_ID,
      userId: author.userId,
      userName: author.userName,
    },
    agentMessage: {
      role: "user",
      content: [
        {
          type: "text",
          text: renderCurrentInstruction(text, {
            authorId: author.userId,
            authorName: author.fullName,
            slackTs: ts,
          }),
        },
      ],
      timestamp: args.createdAtMs,
    },
    conversationMessage: {
      author: {
        fullName: author.fullName,
        isBot: false,
        userId: author.userId,
        userName: author.userName,
      },
      createdAtMs: args.createdAtMs,
      id: ts,
      meta: {
        attachmentCount: 0,
        explicitMention,
        imagesHydrated: true,
        slackFileIds: [],
        slackTs: ts,
        source: "slack",
      },
      role: "user",
      text,
    },
  };
}

const slackFormat = new SlackFormatConverter();

/** The text of a Slack message as Slack ingress stores it for the agent. */
function slackInputText(text: string): string {
  return parseContent({
    attachments: [],
    formatted: slackFormat.toAst(text),
    raw: {},
    text,
  }).text;
}

/** Write `items` as earlier turns. Return the last event sequence. */
export async function loadHistory(args: {
  api: RequestApp;
  conversation: LoadedConversation;
  items: HistoryItem[] | RecordedConversation;
  replyMessages: WeakMap<HistoryReply, string>;
  slack: SlackMock;
  viewerEmail: string;
}): Promise<number> {
  const { conversation } = args;
  const conversationId = conversation.conversationId;
  if (isRecordedConversation(args.items)) {
    return await loadRecording({ ...args, recording: args.items });
  }
  const { appMessages, turns } = groupTurns(args.items);
  if (appMessages.length > 0) {
    if (conversation.surface !== "slack") {
      throw new Error("appMessage() needs a Slack Conversation");
    }
    const app = args.slack.registerAuthor(SLACK_APP);
    for (const [index, message] of appMessages.entries()) {
      args.slack.addThreadMessage(conversation.channelId, {
        attachments: [appMessageContent(message.text)],
        bot_id: SLACK_APP_BOT_ID,
        text: "",
        thread_ts: conversation.threadTs,
        ...(index === 0 ? { ts: conversation.threadTs } : undefined),
        user: app.userId,
      });
    }
  }
  // Junior has no rows for a thread that only apps posted in.
  if (turns.length === 0) return BEFORE_FIRST_EVENT;
  // Earlier turns happened before the call, one millisecond apart.
  let clockMs = Date.now() - args.items.length - 1;
  const tick = () => (clockMs += 1);
  await recordRoot(conversation, tick(), turns[0]?.input);
  const lifecycle = getTurnLifecycle();
  const state = coerceThreadConversationState({});
  // Agent history commits take the full history, not only new messages.
  const agentHistory: PiMessage[] = [];
  const agentProvenance: ConversationMessageProvenance[] = [];

  for (const [index, turn] of turns.entries()) {
    const message = historyUserMessage({
      conversation,
      createdAtMs: tick(),
      first: index === 0 && appMessages.length === 0,
      input: turn.input,
      slack: args.slack,
    });
    const turnId = buildDeterministicTurnId(message.conversationMessage.id);
    // Like a real turn, a later input can reveal the channel's visibility.
    const visibility =
      conversation.surface === "slack" && index > 0
        ? slackInputVisibility(conversation, turn.input)
        : undefined;
    if (visibility) {
      await getConversationStore().recordActivity({
        conversationId,
        nowMs: message.conversationMessage.createdAtMs,
        visibility,
      });
    }
    // A turn stores its input, then starts.
    state.messages.push(message.conversationMessage);
    await appendConversationMessages(getConversationEventStore(), {
      conversation: state,
      conversationId,
    });
    await lifecycle.start({
      conversationId,
      createdAtMs: message.conversationMessage.createdAtMs,
      inputMessageIds: [message.conversationMessage.id],
      surface: conversation.surface === "slack" ? "slack" : "api",
      turnId,
    });
    agentHistory.push(message.agentMessage);
    agentProvenance.push({ authority: "instruction", actor: message.actor });
    await commitMessages({
      conversationId,
      messages: agentHistory,
      provenance: agentProvenance,
    });
    message.conversationMessage.meta = {
      ...message.conversationMessage.meta,
      replied: true,
    };

    for (const [replyIndex, historyReply] of turn.replies.entries()) {
      const repliedAtMs = tick();
      if (historyReply.toolHistory?.length) {
        for (const toolCall of historyReply.toolHistory) {
          for (const toolMessage of toolCallPiMessages(toolCall, repliedAtMs)) {
            agentHistory.push(toolMessage);
            agentProvenance.push(contextProvenance);
          }
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
      const slackTs =
        conversation.surface === "slack"
          ? args.slack.addThreadMessage(conversation.channelId, {
              bot_id: "B_TEST_BOT",
              text: historyReply.text,
              thread_ts: conversation.threadTs,
              user: SLACK_BOT_USER_ID,
            })
          : undefined;
      state.messages.push({
        author: { isBot: true, userName: botConfig.userName },
        createdAtMs: repliedAtMs,
        id: replyId,
        meta: {
          replied: true,
          source: conversation.surface,
          ...(slackTs ? { slackTs } : undefined),
        },
        role: "assistant",
        text: historyReply.text,
      });
      const agentMessage = assistantPiMessage(
        [{ type: "text", text: historyReply.text }],
        repliedAtMs,
      );
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
    }
    if (turn.replies.length === 0) {
      // Junior answered an input that addressed it with the silence marker.
      if (message.conversationMessage.meta?.explicitMention) {
        agentHistory.push(
          assistantPiMessage([{ type: "text", text: NO_REPLY_MARKER }], tick()),
        );
        agentProvenance.push(contextProvenance);
        await commitMessages({
          conversationId,
          messages: agentHistory,
          provenance: agentProvenance,
        });
      }
      await appendConversationMessages(getConversationEventStore(), {
        conversation: state,
        conversationId,
      });
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
