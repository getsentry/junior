import { z } from "zod";
import type { ZodTypeAny } from "zod";
import {
  destinationSchema,
  localActorSchema,
  platformSchema,
  actorSchema,
  slackActorSchema,
  systemActorSchema,
  sourceSchema,
} from "./schemas";

/** Runtime platform name without source or destination coordinates. */
export type Platform = z.output<typeof platformSchema>;
export type Actor = z.output<typeof actorSchema>;
export type SlackActor = z.output<typeof slackActorSchema>;
export type LocalActor = z.output<typeof localActorSchema>;
export type SystemActor = z.output<typeof systemActorSchema>;
export type Source = z.output<typeof sourceSchema>;
export type SlackSource = Extract<Source, { platform: "slack" }>;
export type LocalSource = Extract<Source, { platform: "local" }>;
export type SourceType = Source["type"];

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
  }): Promise<{ object: z.infer<TSchema> }>;
}

export interface PluginEmbedder {
  /** Embed plugin-owned text for derived retrieval without exposing provider credentials. */
  embedTexts(input: { texts: string[] }): Promise<{
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

export type InvocationContext = LocalInvocationContext | SlackInvocationContext;

/** Build a normalized Slack source from runtime-owned Slack coordinates. */
export function createSlackSource(input: {
  channelId: string;
  messageTs?: string;
  teamId: string;
  threadTs?: string;
  /** Runtime-normalized source visibility. */
  type: SourceType;
}): SlackSource {
  return {
    platform: "slack",
    type: input.type,
    teamId: input.teamId,
    channelId: input.channelId,
    ...(input.messageTs ? { messageTs: input.messageTs } : {}),
    ...(input.threadTs ? { threadTs: input.threadTs } : {}),
  };
}

/** Build a normalized local source from a local conversation id. */
export function createLocalSource(conversationId: string): LocalSource {
  return {
    platform: "local",
    type: "priv",
    conversationId,
  };
}

/** Return whether a source is private to a person or restricted group. */
export function isPrivateSource(source: Source): boolean {
  return source.type === "priv";
}

/** Return the stable source identity used for idempotency and attribution. */
export function getSourceKey(source: Source): string | undefined {
  if (source.platform === "local") {
    return source.conversationId;
  }
  const messageKey = source.threadTs ?? source.messageTs;
  if (!messageKey) {
    return undefined;
  }
  return `slack:${source.teamId}:${source.channelId}:${messageKey}`;
}

/** Narrow a runtime destination to the Slack-specific address shape. */
export function isSlackDestination(
  destination: Destination | undefined,
): destination is SlackDestination {
  return destination?.platform === "slack";
}
