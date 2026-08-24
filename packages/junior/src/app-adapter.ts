import type { StateAdapter } from "chat";
import type {
  PluginRoute,
  PluginRouteMethod,
  User,
} from "@sentry/junior-plugin-api";

/** Shared state operations available to app adapters. */
export type JuniorAdapterState = Pick<
  StateAdapter,
  | "acquireLock"
  | "appendToList"
  | "delete"
  | "extendLock"
  | "get"
  | "getList"
  | "releaseLock"
  | "set"
>;

/** One text Message exposed to an app adapter. */
export interface AdapterMessage {
  id: string;
  role: "assistant" | "user";
  text: string;
}

/** Result of admitting one retry-safe prompt to a Conversation. */
export type AdapterPromptAdmission =
  | {
      afterCursor: number;
      messageId: string;
      status: "accepted";
      turnId: string;
    }
  | { status: "active" }
  | { status: "not_found" };

/** Terminal state for one correlated Conversation Turn. */
export type AdapterTurnTerminal =
  | { outcome: "cancelled" | "completed"; status: "completed" }
  | { failureCode: string; status: "failed" };

/** One ordered page of Messages and optional terminal Turn state. */
export interface AdapterTurnPage {
  cursor: number;
  messages: AdapterMessage[];
  terminal?: AdapterTurnTerminal;
}

/** Conversation operations available to app adapters. */
export interface AdapterConversations {
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
  }): Promise<AdapterPromptAdmission>;
  readMessages(conversationId: string): Promise<AdapterMessage[]>;
  readTurn(args: {
    afterCursor: number;
    conversationId: string;
    messageId: string;
    turnId: string;
  }): Promise<AdapterTurnPage>;
}

/** One dashboard-authenticated HTTP route owned by an app adapter. */
export interface JuniorAuthenticatedRoute {
  handler(request: Request, user: User): Promise<Response> | Response;
  method?: PluginRouteMethod | readonly PluginRouteMethod[];
  path: string;
}

/** Capabilities supplied once when Junior configures an app adapter. */
export interface JuniorAppAdapterContext {
  agentName: string;
  baseURL?: string;
  conversations: AdapterConversations;
  reportError(
    error: unknown,
    event: string,
    attributes?: Record<string, unknown>,
  ): void;
  state: JuniorAdapterState;
  version: string;
}

/** HTTP routes returned by one configured app adapter. */
export interface JuniorAppAdapterRoutes {
  authenticatedRoutes?: readonly JuniorAuthenticatedRoute[];
  routes?: readonly PluginRoute[];
}

/** Configure one non-plugin app adapter against Junior's runtime capabilities. */
export type JuniorAppAdapter = (
  context: JuniorAppAdapterContext,
) => JuniorAppAdapterRoutes | Promise<JuniorAppAdapterRoutes>;
