// The app context type, apart from the module that builds it. Code that takes
// the context, or a `Pick` of it, imports the type from here, so it does not
// import the builder and its dependencies.
import type { PluginRegistration } from "@sentry/junior-plugin-api";
import type { ChatConfig } from "@/chat/config";
import type { AppStores } from "@/chat/db";
import type { PluginCatalogRuntime } from "@/chat/plugins/registry";
import type { QueueProvider } from "@/chat/queue/provider";
import type { SlackTeamDomainCache } from "@/chat/slack/team-domain";
import type { SlackUserCache } from "@/chat/slack/user";
import type { AppState } from "@/chat/state/adapter";
import type { Env } from "@/config/fields";
import type { JuniorSqlExecutor } from "@/db/db";

/** Directories that the app reads its content from. */
export interface AppPaths {
  /** The app home directory, with `SOUL.md`, `WORLD.md`, and app content. */
  home: string;
  /** Skill directories: the built-in skills, then the app's. */
  skillRoots: string[];
  /** Directories of app-local plugins. */
  pluginRoots: string[];
}

/** Reads the current time. */
export interface Clock {
  now(): number;
}

/**
 * App services that the composition root (`createApp`, a CLI command, or a
 * test) builds once with `createAppContext`. The context owns its SQL pool,
 * state, and queue clients, and `close()` releases them.
 */
export interface AppContext {
  config: ChatConfig;
  /** The environment that `config` was loaded from. */
  env: Readonly<Env>;
  paths: AppPaths;
  sql: JuniorSqlExecutor;
  stores: AppStores;
  state: AppState;
  queue: QueueProvider;
  /** App plugins, validated and sorted by manifest name. */
  plugins: PluginRegistration[];
  /** The plugin catalog, built from the app plugin config. */
  catalog: PluginCatalogRuntime;
  clock: Clock;
  /** Slack workspace domains that this instance looked up. */
  slackTeamDomains: SlackTeamDomainCache;
  /** The Slack team id of each bot token, looked up once per token. */
  slackBotTeamIds: Map<string, Promise<string>>;
  /** Slack profiles that this instance looked up. */
  slackUsers: SlackUserCache;
  /** Title generation in flight, by Conversation id. */
  conversationTitles: Map<string, Promise<string | undefined>>;
  /** Release the SQL pool, the state connection, and lock heartbeats. */
  close(): Promise<void>;
}
