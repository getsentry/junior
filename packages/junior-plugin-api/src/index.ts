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
  /**
   * @deprecated Put tool-selection and usage guidance directly in `description`
   * and parameter descriptions. Retained for compatibility; may be removed in a
   * future major version.
   */
  promptGuidelines?: string[];
  /**
   * @deprecated Put tool-selection and usage guidance directly in `description`
   * and parameter descriptions. Retained for compatibility; may be removed in a
   * future major version.
   */
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
  credentialSubject?: AgentPluginCredentialSubject;
  messageTs?: string;
  requester?: AgentPluginRequester;
  state: AgentPluginState;
  teamId?: string;
  threadTs?: string;
  userText?: string;
}

export interface AgentPluginCredentialSubject {
  type: "user";
  userId: string;
  allowedWhen: "private-direct-conversation";
}

export interface DispatchOptions {
  credentialSubject?: AgentPluginCredentialSubject;
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

export interface AgentPluginReadState {
  get<T = unknown>(key: string): Promise<T | undefined>;
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

export interface OperationalReportHookContext extends AgentPluginContext {
  nowMs: number;
  state: AgentPluginReadState;
}

export type AgentPluginRouteMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS"
  | "ALL";

export type AgentPluginRouteHandler = {
  bivarianceHack(request: Request): Promise<Response> | Response;
}["bivarianceHack"];

export interface AgentPluginRoute {
  handler: AgentPluginRouteHandler;
  method?: AgentPluginRouteMethod | AgentPluginRouteMethod[];
  path: string;
}

export interface RouteRegistrationHookContext extends AgentPluginContext {}

export interface SlackConversationLink {
  url: string;
}

export interface SlackConversationLinkHookContext extends AgentPluginContext {
  conversationId: string;
}

export interface AgentPluginHooks {
  sandboxPrepare?(ctx: SandboxPrepareHookContext): Promise<void> | void;
  beforeToolExecute?(ctx: BeforeToolExecuteHookContext): Promise<void> | void;
  routes?(ctx: RouteRegistrationHookContext): AgentPluginRoute[];
  tools?(
    ctx: ToolRegistrationHookContext,
  ): Record<string, AgentPluginToolDefinition>;
  heartbeat?(
    ctx: HeartbeatHookContext,
  ): Promise<HeartbeatResult | void> | HeartbeatResult | void;
  operationalReport?(
    ctx: OperationalReportHookContext,
  ):
    | Promise<PluginOperationalReportContent | undefined>
    | PluginOperationalReportContent
    | undefined;
  slackConversationLink?(
    ctx: SlackConversationLinkHookContext,
  ): SlackConversationLink | undefined;
}

export interface JuniorPluginOAuthConfig {
  authorizeEndpoint: string;
  authorizeParams?: Record<string, string>;
  clientIdEnv: string;
  clientSecretEnv: string;
  scope?: string;
  tokenAuthMethod?: "body" | "basic";
  tokenEndpoint: string;
  tokenExtraHeaders?: Record<string, string>;
}

export interface JuniorPluginOAuthBearerCredentials {
  apiHeaders?: Record<string, string>;
  authTokenEnv: string;
  authTokenPlaceholder?: string;
  domains: string[];
  type: "oauth-bearer";
}

export interface JuniorPluginGitHubAppCredentials {
  apiHeaders?: Record<string, string>;
  appIdEnv: string;
  authTokenEnv: string;
  authTokenPlaceholder?: string;
  domains: string[];
  installationIdEnv: string;
  privateKeyEnv: string;
  type: "github-app";
}

export type JuniorPluginCredentials =
  | JuniorPluginOAuthBearerCredentials
  | JuniorPluginGitHubAppCredentials;

export interface JuniorPluginNpmRuntimeDependency {
  package: string;
  type: "npm";
  version: string;
}

export interface JuniorPluginSystemRuntimeDependency {
  package: string;
  type: "system";
}

export interface JuniorPluginSystemRuntimeDependencyFromUrl {
  sha256: string;
  type: "system";
  url: string;
}

export type JuniorPluginRuntimeDependency =
  | JuniorPluginNpmRuntimeDependency
  | JuniorPluginSystemRuntimeDependency
  | JuniorPluginSystemRuntimeDependencyFromUrl;

export interface JuniorPluginRuntimePostinstallCommand {
  args?: string[];
  cmd: string;
  sudo?: boolean;
}

export interface JuniorPluginMcpConfig {
  allowedTools?: string[];
  headers?: Record<string, string>;
  transport: "http";
  url: string;
}

export interface JuniorPluginEnvVarDeclaration {
  default?: string;
  exposeToCommandEnv?: boolean;
}

export interface JuniorPluginManifest {
  apiHeaders?: Record<string, string>;
  capabilities?: string[];
  commandEnv?: Record<string, string>;
  configKeys?: string[];
  credentials?: JuniorPluginCredentials;
  description: string;
  domains?: string[];
  envVars?: Record<string, JuniorPluginEnvVarDeclaration>;
  mcp?: JuniorPluginMcpConfig;
  name: string;
  oauth?: JuniorPluginOAuthConfig;
  runtimeDependencies?: JuniorPluginRuntimeDependency[];
  runtimePostinstall?: JuniorPluginRuntimePostinstallCommand[];
  target?: {
    commandFlags?: string[];
    configKey: string;
    type: string;
  };
}

export type JuniorPluginRegistrationInput = {
  hooks?: AgentPluginHooks;
  legacyStatePrefixes?: string[];
  manifest: JuniorPluginManifest;
  name?: string;
  packageName?: string;
};

export interface JuniorPluginRegistration extends JuniorPluginRegistrationInput {
  name: string;
}

const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Define one Junior plugin registration for app and build-time wiring. */
export function defineJuniorPlugin(
  plugin: JuniorPluginRegistrationInput,
): JuniorPluginRegistration {
  if ("pluginConfig" in plugin) {
    throw new Error(
      "pluginConfig is no longer supported. Put runtime metadata in manifest and trusted state prefixes on the plugin registration.",
    );
  }
  const manifest = plugin.manifest;
  if (!manifest) {
    throw new Error(
      "defineJuniorPlugin() requires a manifest. Use a package name string in defineJuniorPlugins([...]) for plugin.yaml packages.",
    );
  }
  const name = plugin.name ?? manifest.name;
  if (!name) {
    throw new Error(
      "Junior plugin registrations must include name or manifest.name.",
    );
  }
  if (!PLUGIN_NAME_RE.test(name)) {
    throw new Error(
      `Junior plugin registration name "${name}" must be a lowercase plugin identifier.`,
    );
  }
  if (
    typeof manifest.description !== "string" ||
    !manifest.description.trim()
  ) {
    throw new Error(
      `Junior plugin "${name}" manifest.description is required.`,
    );
  }
  if (plugin.name && manifest.name && plugin.name !== manifest.name) {
    throw new Error(
      `Junior plugin registration name "${plugin.name}" must match manifest.name "${manifest.name}".`,
    );
  }
  return {
    ...plugin,
    name,
  };
}
