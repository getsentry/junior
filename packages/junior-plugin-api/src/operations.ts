import { z } from "zod";
import type { PluginContext, User } from "./context";
import type { Dispatch, DispatchOptions, DispatchResult } from "./dispatch";
import { nonBlankStringSchema } from "./schemas";
import type { PluginReadState, PluginState } from "./state";
import type { ResourceEventPublisher } from "./resource-events";
import type { PluginConversationAnnotations } from "./annotations";
import type { PluginConversationEventStats } from "./conversation-events";
import type { CodeChangePublisher } from "./code";

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

export interface UnfinishedWorkHookContext extends PluginContext {
  /** Bounded conversation candidates selected by the host. */
  conversationIds: string[];
}

export interface UnfinishedWorkResult {
  /** Candidate conversations that have plugin-owned work to finish. */
  conversationIds: string[];
  /**
   * Candidate conversations that have any associated plugin-owned work,
   * finished or unfinished. Omit when the plugin cannot distinguish assignment.
   *
   * The host uses this with unfinished work and finish times to set feed
   * `isPriority`. Finished assigned work stays out of Priority unless the
   * conversation has activity after the finish time.
   */
  assignedConversationIds?: string[];
  /**
   * Latest time when all known work finished, keyed by conversation id.
   * ISO-8601 timestamps. Used with conversation activity to decide whether
   * finished work still belongs in Priority.
   */
  finishedWorkAtByConversationId?: Record<string, string>;
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

export interface PluginOperationalChartSeries {
  format?: "usd";
  key: string;
  label: string;
  tone?: PluginOperationalTone;
}

export interface PluginOperationalChartCategory {
  id: string;
  label: string;
  values: Record<string, number>;
}

export interface PluginOperationalBarChartWidget {
  categories: PluginOperationalChartCategory[];
  description?: string;
  emptyText?: string;
  id: string;
  series: PluginOperationalChartSeries[];
  timeRangeDays?: Array<1 | 7 | 30 | 90>;
  title: string;
  type: "bar_chart";
}

export interface PluginOperationalReportContent {
  generatedAt?: string;
  metrics?: PluginOperationalMetric[];
  recordSets?: PluginOperationalRecordSet[];
  title?: string;
  widgets?: PluginOperationalBarChartWidget[];
}

export interface PluginOperationalReport extends PluginOperationalReportContent {
  pluginName: string;
}

export interface OperationalReportHookContext extends PluginContext {
  eventStats: PluginConversationEventStats;
  nowMs: number;
  state: PluginReadState;
}

/** Read-only context for one person-scoped plugin report on a profile page. */
export interface ProfileReportHookContext extends PluginContext {
  nowMs: number;
  state: PluginReadState;
  /** Canonical user for the profile being viewed. */
  subject: User;
  /** Canonical user for the authenticated viewer. */
  viewer: User;
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

export interface RouteRegistrationHookContext extends PluginContext {
  annotations: PluginConversationAnnotations;
  /** Provider-neutral write boundary for Junior's native code index. */
  codeChanges: CodeChangePublisher;
  /** Core-owned delivery boundary for provider webhook events. */
  resourceEvents: ResourceEventPublisher;
}

export interface ApiRouteRegistrationHookContext extends PluginContext {
  eventStats: PluginConversationEventStats;
  users: {
    /** Resolve or create the canonical user for one verified email. */
    resolve(email: string): Promise<User | undefined>;
  };
}

/** Per-request context Junior passes to authenticated plugin product API routes. */
export const pluginApiRouteRequestContextSchema = z
  .object({
    auth: z
      .object({
        user: z
          .object({
            email: z.string().nullable().optional(),
            emailVerified: z.boolean().optional(),
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
