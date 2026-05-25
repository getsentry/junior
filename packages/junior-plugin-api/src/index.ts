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

export interface AgentPluginHooks {
  sandboxPrepare?(ctx: SandboxPrepareHookContext): Promise<void> | void;
  beforeToolExecute?(ctx: BeforeToolExecuteHookContext): Promise<void> | void;
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
