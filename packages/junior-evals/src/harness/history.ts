/**
 * Preload prior turns through the runtime's own write paths.
 *
 * A scenario that tests a later turn needs the earlier exchange to exist the
 * way production would have stored it: in the Slack thread transcript, in the
 * durable agent history, and in the visible conversation messages. No agent
 * runs for these turns; the messages are written as a completed turn would
 * have written them.
 */
import { createSlackSource } from "@sentry/junior-plugin-api";
import { botConfig } from "@/chat/config";
import { commitMessages } from "@/chat/conversations/projection";
import {
  contextProvenance,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";
import { renderCurrentInstruction } from "@/chat/current-instruction";
import { getConversationStore } from "@/chat/db";
import type { PiMessage } from "@/chat/pi/messages";
import { persistThreadState } from "@/chat/runtime/thread-state";
import {
  coerceThreadConversationState,
  type ConversationMessage,
} from "@/chat/state/conversation";
import {
  TEST_BOT_USER_ID,
  TEST_USER_ID,
} from "@junior-tests/fixtures/slack/factories/ids";
import {
  buildRuntimeThreadId,
  createEvalDestination,
  EVAL_SLACK_TEAM_ID,
  recordAssistantPost,
  recordUserMessage,
  toSlackMessage,
  upsertThreadTranscriptMessage,
} from "./threads";
import type {
  EvalEventThreadFixture,
  EvalThreadRecord,
  HistoryEvent,
  RuntimeObservations,
} from "./types";

/** Write prior turns for every thread in `history`, in the given order. */
export async function preloadHistory(args: {
  history: readonly HistoryEvent[];
  getThreadRecord: (
    fixture: EvalEventThreadFixture,
  ) => Promise<EvalThreadRecord>;
  observations: RuntimeObservations;
}): Promise<void> {
  const byThread = new Map<string, HistoryEvent[]>();
  for (const event of args.history) {
    const threadId = buildRuntimeThreadId(event.thread);
    const events = byThread.get(threadId) ?? [];
    events.push(event);
    byThread.set(threadId, events);
  }

  for (const events of byThread.values()) {
    const { thread, transcript } = await args.getThreadRecord(
      events[0]!.thread,
    );
    const destination = createEvalDestination(thread);
    // Preloaded turns predate the scenario's own events.
    const startedAtMs = Date.now() - events.length;
    await getConversationStore().recordActivity({
      conversationId: thread.id,
      destination,
      nowMs: startedAtMs,
      sessionSource: createSlackSource({
        channelId: destination.channelId,
        teamId: destination.teamId,
        ...(thread.threadTs ? { threadTs: thread.threadTs } : undefined),
        visibility: "public",
      }),
      source: "slack",
      visibility: "public",
    });

    const conversation = coerceThreadConversationState({});
    const piMessages: PiMessage[] = [];
    const provenance: ConversationMessageProvenance[] = [];
    let lastReplyIndex = -1;
    for (const [index, event] of events.entries()) {
      if (event.type === "assistant_reply") lastReplyIndex = index;
    }

    for (const [index, event] of events.entries()) {
      const createdAtMs = startedAtMs + index;
      if (event.type === "assistant_reply") {
        for (const item of event.toolHistory ?? []) {
          piMessages.push({ ...item, timestamp: createdAtMs });
          provenance.push(contextProvenance);
        }
        const message = toSlackMessage(
          {
            type: "subscribed_message",
            thread: event.thread,
            message: {
              ...(event.message.id ? { id: event.message.id } : {}),
              text: event.message.text,
              is_mention: false,
              author: {
                user_id: TEST_BOT_USER_ID,
                user_name: botConfig.userName,
                full_name: botConfig.userName,
                is_bot: true,
                is_me: true,
              },
            },
          },
          thread.id,
          createdAtMs,
        );
        upsertThreadTranscriptMessage(transcript, message);
        conversation.messages.push({
          author: {
            isBot: true,
            userId: TEST_BOT_USER_ID,
            userName: botConfig.userName,
          },
          createdAtMs,
          id: message.id,
          meta: { slackTs: message.id, source: "slack" },
          role: "assistant",
          text: event.message.text,
        } satisfies ConversationMessage);
        piMessages.push({
          role: "assistant",
          content: [{ type: "text", text: event.message.text }],
          stopReason: "stop",
          api: "eval-history",
          provider: "eval-history",
          model:
            botConfig.profiles[botConfig.defaultProfile]?.modelId ??
            "eval-history",
          timestamp: createdAtMs,
          usage: { input: 0, output: 0, totalTokens: 0 },
        } as PiMessage);
        provenance.push(contextProvenance);
        recordAssistantPost(args.observations, thread, {
          eventType: "history",
          files: [],
          text: event.message.text,
        });
        continue;
      }

      const author = event.message.author;
      const userId = author?.user_id?.trim() || TEST_USER_ID;
      const message = toSlackMessage(event, thread.id, createdAtMs);
      upsertThreadTranscriptMessage(transcript, message);
      const explicitMention =
        event.message.is_mention ?? event.type === "new_mention";
      conversation.messages.push({
        author: {
          isBot: false,
          userId,
          ...(author?.user_name ? { userName: author.user_name } : {}),
          ...(author?.full_name ? { fullName: author.full_name } : {}),
        },
        createdAtMs,
        id: message.id,
        meta: {
          explicitMention,
          // A reply after this message means the runtime handled it.
          ...(index < lastReplyIndex ? { replied: true } : {}),
          slackTs: message.id,
          source: "slack",
        },
        role: "user",
        text: message.text,
      } satisfies ConversationMessage);
      piMessages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: renderCurrentInstruction(message.text, {
              authorId: userId,
              ...(author?.full_name ? { authorName: author.full_name } : {}),
              slackTs: message.id,
            }),
          },
        ],
        timestamp: createdAtMs,
      } as PiMessage);
      provenance.push({
        authority: "instruction",
        actor: { platform: "slack", teamId: EVAL_SLACK_TEAM_ID, userId },
      });
      recordUserMessage(args.observations, event);
    }

    await commitMessages({
      conversationId: thread.id,
      messages: piMessages,
      provenance,
    });
    await persistThreadState(thread, { conversation });
    if (lastReplyIndex >= 0) {
      // A thread Junior has replied in stays subscribed for follow-ups.
      await thread.subscribe();
    }
  }
}
