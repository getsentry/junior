import { z } from "zod";
import type { ZodTypeAny } from "zod";
import {
  destinationSchema,
  identitySchema,
  locationSchema,
  webActorSchema,
  localActorSchema,
  platformSchema,
  actorSchema,
  slackActorSchema,
  systemActorSchema,
  sourceSchema,
  sourceVisibilitySchema,
  slackLocationSchema,
  userSchema,
} from "./schemas";

/** Runtime platform name without source or destination coordinates. */
export type Platform = z.output<typeof platformSchema>;
export type Actor = z.output<typeof actorSchema>;
export type SlackActor = z.output<typeof slackActorSchema>;
export type LocalActor = z.output<typeof localActorSchema>;
export type WebActor = z.output<typeof webActorSchema>;
export type SystemActor = z.output<typeof systemActorSchema>;
export type Identity = z.output<typeof identitySchema>;
export type User = z.output<typeof userSchema>;
export type Source = z.output<typeof sourceSchema>;
/** Validated Location associated with a Conversation. */
export type Location = z.output<typeof locationSchema>;
/** Complete Slack Location associated with a Conversation. */
export type SlackLocation = z.output<typeof slackLocationSchema>;
export type SlackSource = Extract<Source, { kind: "slack" }>;
export type LocalSource = Extract<Source, { kind: "local" }>;
export type WebSource = Extract<Source, { kind: "web" }>;
export type ResourceEventSource = Extract<Source, { kind: "resource_event" }>;
export type ScheduledTaskSource = Extract<Source, { kind: "scheduled_task" }>;
export type EventTaskSource = Extract<Source, { kind: "event_task" }>;
export type PluginDispatchSource = Extract<Source, { kind: "plugin_dispatch" }>;
export type AgentInvocationSource = Extract<
  Source,
  { kind: "agent_invocation" }
>;
export type SourceVisibility = z.output<typeof sourceVisibilitySchema>;

export type Destination = z.output<typeof destinationSchema>;

export type SlackDestination = Extract<Destination, { platform: "slack" }>;

export type LocalDestination = Extract<Destination, { platform: "local" }>;

export interface PluginMetadata {
  name: string;
}

export interface PluginLogger {
  error(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
}

export interface PluginModel {
  /** Run a host-owned structured model call without exposing provider credentials. */
  completeObject<TSchema extends ZodTypeAny>(input: {
    maxTokens?: number;
    prompt: string;
    schema: TSchema;
    system?: string;
  }): Promise<{
    /** Best-effort estimated provider cost for this completion. */
    costUsd?: number;
    object: z.infer<TSchema>;
  }>;
}

export interface PluginEmbedder {
  /** Embed plugin-owned text for derived retrieval without exposing provider credentials. */
  embedTexts(input: { texts: string[] }): Promise<{
    /** Best-effort estimated provider cost for this embedding call. */
    costUsd?: number;
    dimensions: number;
    model: string;
    provider: string;
    vectors: number[][];
  }>;
}

export interface PluginContext {
  /** Shared Drizzle database connection for plugin runtime code. */
  db: unknown;
  log: PluginLogger;
  plugin: PluginMetadata;
}

interface BaseInvocationContext {
  /**
   * Opaque Junior conversation/session identity for this invocation.
   * Interactive Slack turns use `slack:{channelId}:{threadTs}`.
   */
  conversationId?: string;
  /** Location associated with this Conversation. */
  locationId?: string;
}

export interface SlackInvocationContext extends BaseInvocationContext {
  /** Runtime-owned default outbound destination for this invocation. */
  destination: SlackDestination;
  actor?: SlackActor;
  /** Runtime-owned source where the invocation came from. */
  source: SlackSource;
}

export interface LocalInvocationContext extends BaseInvocationContext {
  /** Runtime-owned default outbound destination for this invocation. */
  destination: LocalDestination;
  actor?: LocalActor;
  /** Runtime-owned source where the invocation came from. */
  source: LocalSource;
}

export interface WebInvocationContext extends BaseInvocationContext {
  /** Existing conversation destination used for location and tool context. */
  destination: Destination;
  actor?: WebActor;
  /** Runtime-owned dashboard/web source for this invocation. */
  source: WebSource;
}

export interface ResourceEventInvocationContext extends BaseInvocationContext {
  /** Existing conversation destination used for tool context. */
  destination: Destination;
  actor?: SystemActor;
  /** Runtime-owned Resource event Source for this invocation. */
  source: ResourceEventSource;
}

export type InvocationContext =
  | LocalInvocationContext
  | SlackInvocationContext
  | WebInvocationContext
  | (BaseInvocationContext & {
      destination: Destination;
      actor?: SystemActor;
      source:
        | AgentInvocationSource
        | EventTaskSource
        | PluginDispatchSource
        | ResourceEventSource
        | ScheduledTaskSource;
    });

/** Build a normalized Slack source from runtime-owned Slack coordinates. */
export function createSlackSource(input: {
  channelId: string;
  messageTs?: string;
  teamId: string;
  threadTs?: string;
  /** Runtime-normalized source visibility. */
  visibility: SourceVisibility;
}): SlackSource {
  return {
    kind: "slack",
    visibility: input.visibility,
    teamId: input.teamId,
    channelId: input.channelId,
    ...(input.messageTs ? { messageTs: input.messageTs } : undefined),
    ...(input.threadTs ? { threadTs: input.threadTs } : undefined),
  };
}

/** Build a normalized local source from a local conversation id. */
export function createLocalSource(conversationId: string): LocalSource {
  return {
    kind: "local",
    visibility: "private",
    conversationId,
  };
}

/** Build a normalized web/dashboard source from a conversation id. */
export function createWebSource(
  conversationId: string,
  visibility: SourceVisibility = "public",
): WebSource {
  return {
    kind: "web",
    visibility,
    conversationId,
  };
}

/** Build a normalized Resource event Source from one matched event. */
export function createResourceEventSource(input: {
  eventKey: string;
  eventType: string;
  identifier: string;
  namespace: string;
}): ResourceEventSource {
  return {
    kind: "resource_event",
    eventKey: input.eventKey,
    eventType: input.eventType,
    identifier: input.identifier,
    namespace: input.namespace,
  };
}

/** Return whether a source is private to a person or restricted group. */
export function isPrivateSource(source: Source): boolean {
  return "visibility" in source && source.visibility === "private";
}

/** Return the stable source identity used for idempotency and attribution. */
export function getSourceKey(source: Source): string | undefined {
  switch (source.kind) {
    case "web":
    case "local":
      return source.conversationId;
    case "slack": {
      const messageKey = source.threadTs ?? source.messageTs;
      if (!messageKey) {
        return undefined;
      }
      return `slack:${source.teamId}:${source.channelId}:${messageKey}`;
    }
    case "resource_event":
      return `resource-event:${source.namespace}:${source.eventKey}`;
    case "scheduled_task":
    case "event_task":
    case "plugin_dispatch":
    case "agent_invocation":
      return undefined;
  }
}

/** Narrow a runtime destination to the Slack-specific address shape. */
export function isSlackDestination(
  destination: Destination | undefined,
): destination is SlackDestination {
  return destination?.platform === "slack";
}
