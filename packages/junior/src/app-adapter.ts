import type { PluginRouteMethod, User } from "@sentry/junior-plugin-api";

/** One lock held by an app adapter in Junior's shared state. */
export interface JuniorAdapterLock {
  expiresAt: number;
  threadId: string;
  token: string;
}

/** Shared state operations available to app adapters. */
export interface JuniorAdapterState {
  acquireLock(key: string, ttlMs: number): Promise<JuniorAdapterLock | null>;
  appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  extendLock(lock: JuniorAdapterLock, ttlMs: number): Promise<boolean>;
  get<T = unknown>(key: string): Promise<T | null>;
  getList<T = unknown>(key: string): Promise<T[]>;
  releaseLock(lock: JuniorAdapterLock): Promise<void>;
  set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void>;
}

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

/** One unauthenticated HTTP route owned by an app adapter. */
export interface JuniorAdapterRoute {
  handler(request: Request): Promise<Response> | Response;
  method?: PluginRouteMethod | readonly PluginRouteMethod[];
  path: string;
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
  routes?: readonly JuniorAdapterRoute[];
}

/** Configure one non-plugin app adapter against Junior's runtime capabilities. */
export type JuniorAppAdapter = (
  context: JuniorAppAdapterContext,
) => JuniorAppAdapterRoutes | Promise<JuniorAppAdapterRoutes>;
