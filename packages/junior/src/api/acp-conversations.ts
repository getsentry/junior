/**
 * Bind the protocol adapter port to Junior's Conversation runtime.
 *
 * The ACP package cannot reach the mailbox, worker, database, or Conversation
 * event store directly. Core implements the transport package's narrow port.
 */
import type { StateAdapter } from "chat";
import type {
  ConversationPort,
  ConversationTurnPage,
  ConversationTurnTerminal,
} from "@sentry/junior-acp";
import type { User } from "@sentry/junior-plugin-api";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import {
  apiConversationMessageId,
  apiTurnIdForMessage,
  buildApiTurnInboundMessage,
  recordApiConversationActivity,
  webActorFromEmail,
} from "@/chat/api-turns/work";
import { getAuthPausedApiTurnId } from "@/chat/api-turns/routing";
import { stopApiConversationTurn } from "@/chat/api-turns/stop";
import type { ConversationEventStore } from "@/chat/conversations/history";
import { projectConversationMessages } from "@/chat/conversations/message-projection";
import type { ConversationStore } from "@/chat/conversations/store";
import { getDb } from "@/chat/db";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  appendAndEnqueueExclusiveInboundMessage,
  getConversation,
  hasRunnableConversationWork,
} from "@/chat/task-execution/store";

const EVENT_PAGE_SIZE = 50;

interface AcpConversationOptions {
  conversationStore?: ConversationStore;
  eventStore: ConversationEventStore;
  queue: ConversationWorkQueue;
  state: StateAdapter;
}

function actorFromUser(user: User) {
  return webActorFromEmail(
    user.email,
    user.displayName ? { fullName: user.displayName } : undefined,
  );
}

async function hasConversationAccess(
  conversationId: string,
  user: User,
): Promise<boolean> {
  const access = (
    await readConversationAccessFromSql(getDb(), [conversationId], user)
  ).get(conversationId);
  return Boolean(access?.isParticipant);
}

/** Return whether shared Conversation state still blocks the next ACP prompt. */
async function hasRunnableWork(args: {
  conversationId: string;
  state: StateAdapter;
}): Promise<boolean> {
  const conversation = await getConversation({
    conversationId: args.conversationId,
    state: args.state,
  });
  return conversation ? hasRunnableConversationWork(conversation) : false;
}

async function latestEventCursor(
  eventStore: ConversationEventStore,
  conversationId: string,
): Promise<number> {
  const page = await eventStore.query(conversationId, { limit: 1 });
  return page.events.at(-1)?.seq ?? 0;
}

async function appendAndEnqueueAcpPrompt(args: {
  conversationId: string;
  idempotencyKey: string;
  options: AcpConversationOptions;
  text: string;
  user: User;
}): Promise<{
  messageId: string;
  status: "accepted" | "active" | "duplicate";
}> {
  const text = args.text.trim();
  if (!text) throw new Error("ACP prompt must not be empty");
  const actor = actorFromUser(args.user);
  const nowMs = Date.now();
  const messageId = apiConversationMessageId({
    conversationId: args.conversationId,
    idempotencyKey: args.idempotencyKey,
  });
  if (await getAuthPausedApiTurnId(args.conversationId)) {
    return { messageId, status: "active" };
  }
  const destination = await recordApiConversationActivity({
    actor,
    conversationId: args.conversationId,
    conversationStore: args.options.conversationStore,
    nowMs,
  });
  const result = await appendAndEnqueueExclusiveInboundMessage({
    message: buildApiTurnInboundMessage({
      actor,
      conversationId: args.conversationId,
      destination,
      message: text,
      messageId,
      nowMs,
    }),
    conversationStore: args.options.conversationStore,
    nowMs,
    queue: args.options.queue,
    state: args.options.state,
  });
  return {
    messageId,
    status: result.status === "appended" ? "accepted" : result.status,
  };
}

/** Create the narrow Conversation capability consumed by remote ACP. */
export function createAcpConversationPort(
  options: AcpConversationOptions,
): ConversationPort {
  return {
    async cancel({ conversationId, user }) {
      if (!(await hasConversationAccess(conversationId, user))) {
        return "not_found";
      }
      await stopApiConversationTurn({
        conversationId,
        conversationStore: options.conversationStore,
        queue: options.queue,
        state: options.state,
      });
      return "cancelled";
    },

    async createConversation({ conversationId, user }) {
      await recordApiConversationActivity({
        actor: actorFromUser(user),
        conversationId,
        conversationStore: options.conversationStore,
        nowMs: Date.now(),
        rootVisibility: "private",
      });
    },

    async hasConversationAccess({ conversationId, user }) {
      return await hasConversationAccess(conversationId, user);
    },

    async prompt({ conversationId, idempotencyKey, text, user }) {
      if (!(await hasConversationAccess(conversationId, user))) {
        return { status: "not_found" };
      }
      const currentCursor = await latestEventCursor(
        options.eventStore,
        conversationId,
      );
      const admission = await appendAndEnqueueAcpPrompt({
        conversationId,
        idempotencyKey,
        options,
        text,
        user,
      });
      if (admission.status === "active") return { status: "active" };

      return {
        afterCursor: admission.status === "duplicate" ? 0 : currentCursor,
        messageId: admission.messageId,
        status: "accepted",
        turnId: apiTurnIdForMessage(admission.messageId),
      };
    },

    async readMessages(conversationId) {
      const history =
        await options.eventStore.loadMessageHistory(conversationId);
      return projectConversationMessages(history)
        .filter(
          (
            message,
          ): message is typeof message & {
            role: "assistant" | "user";
          } => message.role !== "system",
        )
        .map(({ id, role, text }) => ({ id, role, text }));
    },

    async readTurn({ afterCursor, conversationId, turnId }) {
      const page = await options.eventStore.query(conversationId, {
        afterSeq: afterCursor,
        limit: EVENT_PAGE_SIZE,
        types: ["message", "turn_completed", "turn_failed"],
      });
      const cursor = page.events.at(-1)?.seq ?? afterCursor;
      const assistantPrefix = `${turnId}:assistant:`;
      const messages = page.events.flatMap((event) => {
        const data = event.data;
        return data.type === "message" &&
          data.role === "assistant" &&
          data.messageId.startsWith(assistantPrefix)
          ? [
              {
                id: data.messageId,
                role: "assistant" as const,
                text: data.text,
              },
            ]
          : [];
      });

      let terminal: ConversationTurnTerminal | undefined;
      const terminalEvent = await options.eventStore.loadByIdempotencyKey(
        conversationId,
        `turn:${turnId}:terminal`,
      );
      if (
        terminalEvent &&
        terminalEvent.seq <= cursor &&
        !(await hasRunnableWork({
          conversationId,
          state: options.state,
        }))
      ) {
        const data = terminalEvent.data;
        if (data.type === "turn_completed" && data.turnId === turnId) {
          terminal = {
            outcome: data.outcome === "cancelled" ? "cancelled" : "completed",
            status: "completed",
          };
        } else if (data.type === "turn_failed" && data.turnId === turnId) {
          terminal = { failureCode: data.failureCode, status: "failed" };
        }
      }
      const turnPage: ConversationTurnPage = { cursor, messages };
      if (terminal) turnPage.terminal = terminal;
      return turnPage;
    },
  };
}
