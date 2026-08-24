import type { User } from "./context";

/** One text Message exposed through the plugin Conversation boundary. */
export interface PluginConversationMessage {
  id: string;
  role: "assistant" | "user";
  text: string;
}

/** Result of admitting one retry-safe prompt to a Conversation. */
export type PluginPromptAdmission =
  | {
      afterCursor: number;
      messageId: string;
      status: "accepted";
      turnId: string;
    }
  | { status: "active" }
  | { status: "not_found" };

/** Terminal state for one correlated Conversation Turn. */
export type PluginTurnTerminal =
  | { outcome: "cancelled" | "completed"; status: "completed" }
  | { failureCode: string; status: "failed" };

/** One ordered page of Messages and optional terminal Turn state. */
export interface PluginTurnPage {
  cursor: number;
  messages: PluginConversationMessage[];
  terminal?: PluginTurnTerminal;
}

/** Provider-neutral Conversation operations available to plugin routes. */
export interface PluginConversations {
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
  }): Promise<PluginPromptAdmission>;
  readMessages(conversationId: string): Promise<PluginConversationMessage[]>;
  readTurn(args: {
    afterCursor: number;
    conversationId: string;
    messageId: string;
    turnId: string;
  }): Promise<PluginTurnPage>;
}
