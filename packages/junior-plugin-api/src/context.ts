import { z } from "zod";
import {
  destinationSchema,
  localRequesterSchema,
  requesterSchema,
  slackRequesterSchema,
  sourceSchema,
} from "./schemas";
import type { PluginDb } from "./database";

export type Requester = z.output<typeof requesterSchema>;
export type SlackRequester = z.output<typeof slackRequesterSchema>;
export type LocalRequester = z.output<typeof localRequesterSchema>;
export type Source = z.output<typeof sourceSchema>;
export type SlackSource = Extract<Source, { platform: "slack" }>;
export type LocalSource = Extract<Source, { platform: "local" }>;

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

export interface PluginContext {
  /** Shared database connection for plugins that declare database access. */
  db?: PluginDb;
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
  /** Runtime-owned default outbound destination for this invocation, if any. */
  destination?: SlackDestination;
  requester?: SlackRequester;
  /** Runtime-owned source where the invocation came from. */
  source: SlackSource;
}

export interface LocalInvocationContext extends BaseInvocationContext {
  /** Runtime-owned default outbound destination for this invocation, if any. */
  destination?: LocalDestination;
  requester?: LocalRequester;
  /** Runtime-owned source where the invocation came from. */
  source: LocalSource;
}

export type InvocationContext = LocalInvocationContext | SlackInvocationContext;

/** Narrow a runtime destination to the Slack-specific address shape. */
export function isSlackDestination(
  destination: Destination | undefined,
): destination is SlackDestination {
  return destination?.platform === "slack";
}
