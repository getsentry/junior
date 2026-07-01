import { z } from "zod";
import type { PluginContext } from "./context";
import type { Dispatch, DispatchOptions, DispatchResult } from "./dispatch";
import { nonBlankStringSchema } from "./schemas";
import type { PluginReadState, PluginState } from "./state";

export type PluginConversationStatus =
  | "active"
  | "completed"
  | "failed"
  | "hung"
  | "superseded";

export interface PluginConversationSummary {
  channelName?: string;
  conversationId: string;
  displayTitle: string;
  lastActivityAt: string;
  lastUpdatedAt: string;
  source?:
    | "api"
    | "internal"
    | "local"
    | "plugin"
    | "resource_event"
    | "scheduler"
    | "slack";
  status: PluginConversationStatus;
}

export interface PluginConversations {
  listRecent(options?: {
    limit?: number;
  }): Promise<PluginConversationSummary[]>;
}

export interface HeartbeatHookContext extends PluginContext {
  agent: {
    dispatch(options: DispatchOptions): Promise<DispatchResult>;
    get(id: string): Promise<Dispatch | undefined>;
  };
  nowMs: number;
  state: PluginState;
}

export interface HeartbeatResult {
  dispatchCount?: number;
}

export interface StorageMigrationResult {
  existing: number;
  migrated: number;
  missing: number;
  scanned: number;
  skipped?: number;
}

export interface StorageMigrationContext extends PluginContext {
  state: PluginState;
}

export type PluginOperationalTone = "danger" | "good" | "neutral" | "warning";

export interface PluginOperationalMetric {
  label: string;
  tone?: PluginOperationalTone;
  value: string;
}

export interface PluginOperationalField {
  key: string;
  label: string;
}

export interface PluginOperationalRecord {
  id: string;
  tone?: PluginOperationalTone;
  values: Record<string, string>;
}

export interface PluginOperationalRecordSet {
  fields?: PluginOperationalField[];
  emptyText?: string;
  records?: PluginOperationalRecord[];
  title: string;
}

export interface PluginOperationalReportContent {
  generatedAt?: string;
  metrics?: PluginOperationalMetric[];
  recordSets?: PluginOperationalRecordSet[];
  title?: string;
}

export interface PluginOperationalReport extends PluginOperationalReportContent {
  pluginName: string;
}

export interface OperationalReportHookContext extends PluginContext {
  conversations: PluginConversations;
  nowMs: number;
  state: PluginReadState;
}

export type PluginRouteMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS"
  | "ALL";

export type PluginRouteHandler = {
  bivarianceHack(request: Request): Promise<Response> | Response;
}["bivarianceHack"];

export interface PluginRoute {
  handler: PluginRouteHandler;
  method?: PluginRouteMethod | PluginRouteMethod[];
  path: string;
}

/** Fetch-compatible plugin HTTP app mounted by Junior. */
export type PluginRouteApp = {
  fetch(
    request: Request,
    context?: PluginApiRouteRequestContext,
  ): Promise<Response> | Response;
};

export interface RouteRegistrationHookContext extends PluginContext {}

export interface ApiRouteRegistrationHookContext extends PluginContext {}

/** Per-request context Junior passes to authenticated plugin product API routes. */
export const pluginApiRouteRequestContextSchema = z
  .object({
    auth: z
      .object({
        user: z
          .object({
            email: z.string().nullable().optional(),
            emailVerified: z.boolean().optional(),
            hostedDomain: z.string().nullable().optional(),
            name: z.string().nullable().optional(),
          })
          .strict(),
      })
      .strict(),
    pluginName: nonBlankStringSchema,
  })
  .strict();

export type PluginApiRouteRequestContext = z.output<
  typeof pluginApiRouteRequestContextSchema
>;

export interface SlackConversationLink {
  url: string;
}

export interface SlackConversationLinkHookContext extends PluginContext {
  conversationId: string;
}
