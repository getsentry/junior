import type { User } from "@sentry/junior-plugin-api";

/** One text Message exposed through the ACP Conversation port. */
export interface ConversationTextMessage {
  id: string;
  role: "assistant" | "user";
  text: string;
}

/** Result of admitting one retry-stable prompt to a Conversation. */
export type ConversationPromptAdmission =
  | {
      afterCursor: number;
      messageId: string;
      status: "accepted";
      turnId: string;
    }
  | { status: "active" }
  | { status: "not_found" };

/** Terminal state for one correlated Conversation Turn. */
export type ConversationTurnTerminal =
  | { outcome: "cancelled" | "completed"; status: "completed" }
  | { failureCode: string; status: "failed" };

/** One ordered page of Messages and optional terminal Turn state. */
export interface ConversationTurnPage {
  cursor: number;
  messages: ConversationTextMessage[];
  terminal?: ConversationTurnTerminal;
}

/** Junior Conversation operations required by the ACP adapter. */
export interface ConversationPort {
  cancel(args: {
    conversationId: string;
    user: User;
  }): Promise<"cancelled" | "not_found">;
  createConversation(args: {
    conversationId: string;
    user: User;
  }): Promise<void>;
  hasConversationAccess(args: {
    conversationId: string;
    user: User;
  }): Promise<boolean>;
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

export interface AcpErrorContext {
  connectionId?: string;
  conversationId?: string;
  userId?: string;
}

export type ReportAcpError = (
  error: unknown,
  event: string,
  context: AcpErrorContext,
) => void;
