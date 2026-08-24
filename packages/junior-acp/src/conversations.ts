import type { User } from "@sentry/junior-plugin-api";

export interface ConversationTextMessage {
  id: string;
  role: "assistant" | "user";
  text: string;
}

export type ConversationPromptAdmission =
  | {
      afterCursor: number;
      messageId: string;
      status: "accepted";
      turnId: string;
    }
  | { status: "active" }
  | { status: "not_found" };

export type ConversationTurnTerminal =
  | { outcome: "cancelled" | "completed"; status: "completed" }
  | { failureCode: string; status: "failed" };

export interface ConversationTurnPage {
  cursor: number;
  messages: ConversationTextMessage[];
  terminal?: ConversationTurnTerminal;
}

export interface ConversationPort {
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
  }): Promise<ConversationPromptAdmission>;
  readMessages(conversationId: string): Promise<ConversationTextMessage[]>;
  readTurn(args: {
    afterCursor: number;
    conversationId: string;
    messageId: string;
    turnId: string;
  }): Promise<ConversationTurnPage>;
}
