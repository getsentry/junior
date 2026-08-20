import { z } from "zod";
import type { ZodTypeAny } from "zod";
import {
  destinationSchema,
  identitySchema,
  webActorSchema,
  localActorSchema,
  platformSchema,
  actorSchema,
  slackActorSchema,
  systemActorSchema,
  sourceSchema,
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
export type SlackSource = Extract<Source, { platform: "slack" }>;
export type LocalSource = Extract<Source, { platform: "local" }>;
export type WebSource = Extract<Source, { platform: "web" }>;
export type SourceVisibility = Source["visibility"];

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

export interface PluginUserContext {
  /** Resolve the current actor's stored identity and/or linked user. */
  resolveActor(): Promise<{ identity?: Identity; user?: User } | undefined>;
}

interface BaseInvocationContext {
  /**
   * Opaque Junior conversation/session identity for this invocation.
   * Interactive Slack turns use `slack:{channelId}:{threadTs}`.
   */
  conversationId?: string;
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

export type InvocationContext =
  | LocalInvocationContext
  | SlackInvocationContext
  | WebInvocationContext;

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
    platform: "slack",
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
    platform: "local",
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
    platform: "web",
    visibility,
    conversationId,
  };
}

/** Return whether a source is private to a person or restricted group. */
export function isPrivateSource(source: Source): boolean {
  return source.visibility === "private";
}

/** Return the stable source identity used for idempotency and attribution. */
export function getSourceKey(source: Source): string | undefined {
  switch (source.platform) {
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
  }
}

/** Narrow a runtime destination to the Slack-specific address shape. */
export function isSlackDestination(
  destination: Destination | undefined,
): destination is SlackDestination {
  return destination?.platform === "slack";
}
