export interface AgentPluginRequester {
  userId?: string;
  userName?: string;
  fullName?: string;
  email?: string;
}

export interface AgentPluginMetadata {
  name: string;
}

export interface AgentPluginEnv {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export interface AgentPluginDecision {
  deny(message: string): void;
  replaceInput(input: Record<string, unknown>): void;
}

export interface AgentPluginLogger {
  error(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
}

/** Thrown when a trusted plugin tool rejects invalid model or user input. */
export class AgentPluginToolInputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentPluginToolInputError";
  }
}

export interface AgentPluginContext {
  log: AgentPluginLogger;
  plugin: AgentPluginMetadata;
}

export interface AgentPluginSandbox {
  juniorRoot: string;
  root: string;
  readFile(path: string): Promise<Uint8Array | null>;
  run(input: {
    args?: string[];
    cmd: string;
    cwd?: string;
    env?: Record<string, string>;
    sudo?: boolean;
  }): Promise<{
    exitCode: number;
    stderr: string;
    stdout: string;
  }>;
  writeFile(input: {
    content: string | Uint8Array;
    mode?: number;
    path: string;
  }): Promise<void>;
}

export interface SandboxPrepareHookContext extends AgentPluginContext {
  requester?: AgentPluginRequester;
  sandbox: AgentPluginSandbox;
}

export interface BeforeToolExecuteHookContext extends AgentPluginContext {
  decision: AgentPluginDecision;
  env: AgentPluginEnv;
  requester?: AgentPluginRequester;
  tool: {
    input: Record<string, unknown>;
    name: string;
  };
}

export type AgentPluginToolExecute<TInput = unknown> = {
  bivarianceHack(
    input: TInput,
    options: { experimental_context?: unknown },
  ): Promise<unknown> | unknown;
}["bivarianceHack"];

export interface AgentPluginToolDefinition<TInput = unknown> {
  annotations?: unknown;
  description: string;
  executionMode?: unknown;
  inputSchema: unknown;
  prepareArguments?: (args: unknown) => unknown;
  promptGuidelines?: string[];
  promptSnippet?: string;
  execute?: AgentPluginToolExecute<TInput>;
}

export interface ToolRegistrationHookContext extends AgentPluginContext {
  channelCapabilities?: {
    canAddReactions: boolean;
    canCreateCanvas: boolean;
    canPostToChannel: boolean;
  };
  channelId?: string;
  messageTs?: string;
  requester?: AgentPluginRequester;
  state: AgentPluginState;
  teamId?: string;
  threadTs?: string;
  userText?: string;
}

export interface DispatchOptions {
  credentialSubject?: {
    type: "user";
    userId: string;
    allowedWhen: "private-direct-conversation";
  };
  destination: {
    platform: "slack";
    teamId: string;
    channelId: string;
  };
  idempotencyKey: string;
  input: string;
  metadata?: Record<string, string>;
}

export interface DispatchResult {
  id: string;
  status: "created" | "already_exists";
}

export interface Dispatch {
  errorMessage?: string;
  id: string;
  resultMessageTs?: string;
  status:
    | "pending"
    | "running"
    | "awaiting_resume"
    | "completed"
    | "failed"
    | "blocked";
}

export interface AgentPluginState {
  delete(key: string): Promise<void>;
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean>;
  withLock<T>(
    key: string,
    ttlMs: number,
    callback: () => Promise<T>,
  ): Promise<T>;
}

export interface HeartbeatHookContext extends AgentPluginContext {
  agent: {
    dispatch(options: DispatchOptions): Promise<DispatchResult>;
    get(id: string): Promise<Dispatch | undefined>;
  };
  nowMs: number;
  state: AgentPluginState;
}

export interface HeartbeatResult {
  dispatchCount?: number;
}

export interface AgentPluginHooks {
  sandboxPrepare?(ctx: SandboxPrepareHookContext): Promise<void> | void;
  beforeToolExecute?(ctx: BeforeToolExecuteHookContext): Promise<void> | void;
  tools?(
    ctx: ToolRegistrationHookContext,
  ): Record<string, AgentPluginToolDefinition>;
  heartbeat?(
    ctx: HeartbeatHookContext,
  ): Promise<HeartbeatResult | void> | HeartbeatResult | void;
}

export interface JuniorPluginConfig {
  legacyStatePrefixes?: string[];
  packages?: string[];
}

export interface JuniorPlugin {
  hooks?: AgentPluginHooks;
  name: string;
  pluginConfig?: JuniorPluginConfig;
}

/** Define a trusted Junior plugin with optional package config and agent hooks. */
export function defineJuniorPlugin(plugin: JuniorPlugin): JuniorPlugin {
  return plugin;
}
