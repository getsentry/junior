/** Bind ACP sessions to Junior's existing Conversation runtime. */
import type { StateAdapter } from "chat";
import type { User } from "@sentry/junior-plugin-api";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import {
  apiTurnIdForMessage,
  appendAndEnqueueApiConversationMessage,
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
import { getConversation } from "@/chat/task-execution/store";
import { hasRunnableConversationWork } from "@/chat/task-execution/state";

const EVENT_PAGE_SIZE = 50;

type ConversationMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

type PromptAdmission =
  | {
      afterCursor: number;
      messageId: string;
      status: "accepted";
      turnId: string;
    }
  | { status: "active" }
  | { status: "not_found" };

type TurnTerminal =
  | { outcome: "cancelled" | "completed"; status: "completed" }
  | { failureCode: string; status: "failed" };

type TurnPage = {
  cursor: number;
  messages: ConversationMessage[];
  terminal?: TurnTerminal;
};

/** ACP operations backed by Junior Conversations. */
export type AcpConversations = {
  cancel(args: {
    conversationId: string;
    user: User;
  }): Promise<"cancelled" | "not_found">;
  create(args: { conversationId: string; user: User }): Promise<void>;
  hasAccess(args: { conversationId: string; user: User }): Promise<boolean>;
  prompt(args: {
    conversationId: string;
    idempotencyKey: string;
    text: string;
    user: User;
  }): Promise<PromptAdmission>;
  readMessages(conversationId: string): Promise<ConversationMessage[]>;
  readTurn(args: {
    afterCursor: number;
    conversationId: string;
    messageId: string;
    turnId: string;
  }): Promise<TurnPage>;
};

interface ConversationOptions {
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

/** Return whether one Turn can publish its terminal result without racing cleanup. */
async function turnTerminalIsReady(args: {
  conversationId: string;
  eventStore: ConversationEventStore;
  messageId: string;
  state: StateAdapter;
  terminalSeq: number;
  turnId: string;
}): Promise<boolean> {
  const conversation = await getConversation({
    conversationId: args.conversationId,
    state: args.state,
  });
  if (
    conversation?.execution.pendingMessages.some(
      (message) => message.inboundMessageId === args.messageId,
    )
  ) {
    return false;
  }
  if (!conversation || !hasRunnableConversationWork(conversation)) {
    return true;
  }

  const later = await args.eventStore.query(args.conversationId, {
    afterSeq: args.terminalSeq,
    limit: 1,
    types: ["turn_started"],
  });
  return later.events.some(
    (event) =>
      event.data.type === "turn_started" && event.data.turnId !== args.turnId,
  );
}

async function latestEventCursor(
  eventStore: ConversationEventStore,
  conversationId: string,
): Promise<number> {
  const page = await eventStore.query(conversationId, { limit: 1 });
  return page.events.at(-1)?.seq ?? 0;
}

/** Create the ACP view of Junior's Conversation runtime. */
export function createAcpConversations(
  options: ConversationOptions,
): AcpConversations {
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

    async create({ conversationId, user }) {
      await recordApiConversationActivity({
        actor: actorFromUser(user),
        conversationId,
        conversationStore: options.conversationStore,
        nowMs: Date.now(),
        rootVisibility: "private",
      });
    },

    async hasAccess({ conversationId, user }) {
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
      if (await getAuthPausedApiTurnId(conversationId)) {
        return { status: "active" };
      }
      const admission = await appendAndEnqueueApiConversationMessage(
        {
          actor: actorFromUser(user),
          conversationId,
          idempotencyKey,
          message: text,
        },
        {
          conversationStore: options.conversationStore,
          exclusive: true,
          queue: options.queue,
          state: options.state,
        },
      );
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

    async readTurn({ afterCursor, conversationId, messageId, turnId }) {
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

      let terminal: TurnTerminal | undefined;
      const terminalEvent = await options.eventStore.loadByIdempotencyKey(
        conversationId,
        `turn:${turnId}:terminal`,
      );
      if (
        terminalEvent &&
        terminalEvent.seq <= cursor &&
        (await turnTerminalIsReady({
          conversationId,
          eventStore: options.eventStore,
          messageId,
          state: options.state,
          terminalSeq: terminalEvent.seq,
          turnId,
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
      const turnPage: TurnPage = { cursor, messages };
      if (terminal) turnPage.terminal = terminal;
      return turnPage;
    },
  };
}
