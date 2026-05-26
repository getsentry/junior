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

export interface SandboxPrepareHookContext {
  plugin: AgentPluginMetadata;
  requester?: AgentPluginRequester;
  sandbox: AgentPluginSandbox;
}

export interface BeforeToolExecuteHookContext {
  decision: AgentPluginDecision;
  env: AgentPluginEnv;
  plugin: AgentPluginMetadata;
  requester?: AgentPluginRequester;
  tool: {
    input: Record<string, unknown>;
    name: string;
  };
}

export interface DispatchOptions {
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
}

export interface AgentPluginLogger {
  error(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
}

export interface HeartbeatHookContext {
  agent: {
    dispatch(options: DispatchOptions): Promise<DispatchResult>;
    get(id: string): Promise<Dispatch | undefined>;
  };
  log: AgentPluginLogger;
  nowMs: number;
  state: AgentPluginState;
}

export interface HeartbeatResult {
  dispatchCount?: number;
}

export interface AgentPluginHooks {
  sandboxPrepare?(ctx: SandboxPrepareHookContext): Promise<void> | void;
  beforeToolExecute?(ctx: BeforeToolExecuteHookContext): Promise<void> | void;
  heartbeat?(
    ctx: HeartbeatHookContext,
  ): Promise<HeartbeatResult | void> | HeartbeatResult | void;
}

export interface JuniorPluginConfig {
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
