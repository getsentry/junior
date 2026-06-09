import { z } from "zod";

const slackTeamIdSchema = z.string().regex(/^T[A-Z0-9]+$/);
const slackConversationIdSchema = z.string().regex(/^(C|G|D)[A-Z0-9]+$/);
const exactActorUserIdSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value === value.trim() && value.toLowerCase() !== "unknown",
  );
const nonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0);

/** Runtime-owned provider-neutral address for routing future work or side effects. */
export const destinationSchema = z
  .object({
    platform: z.literal("slack"),
    teamId: slackTeamIdSchema,
    channelId: slackConversationIdSchema,
  })
  .strict();

/** Stable user credential subject shape accepted from plugins. */
export const agentPluginCredentialSubjectSchema = z
  .object({
    type: z.literal("user"),
    userId: exactActorUserIdSchema,
    allowedWhen: z.literal("private-direct-conversation"),
  })
  .strict();

/** Runtime-provided requester identity visible to plugin hooks. */
export const requesterSchema = z
  .object({
    platform: z.literal("slack"),
    teamId: slackTeamIdSchema,
    userId: exactActorUserIdSchema,
    userName: nonBlankStringSchema.optional(),
    fullName: nonBlankStringSchema.optional(),
    email: nonBlankStringSchema.optional(),
  })
  .strict();

const dispatchMetadataSchema = z
  .record(z.string(), z.string())
  .superRefine((metadata, ctx) => {
    const entries = Object.entries(metadata);
    if (entries.length > 20) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Dispatch metadata has too many keys",
      });
      return;
    }
    for (const [key, value] of entries) {
      if (!key.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Dispatch metadata values must be strings",
          path: [key],
        });
        continue;
      }
      if (key.length > 128) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Dispatch metadata key exceeds the maximum length",
          path: [key],
        });
      }
      if (value.length > 512) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Dispatch metadata value exceeds the maximum length",
          path: [key],
        });
      }
    }
  });

/** Plugin dispatch request accepted by Junior core. */
export const dispatchOptionsSchema = z
  .object({
    idempotencyKey: nonBlankStringSchema.pipe(z.string().max(512)),
    credentialSubject: agentPluginCredentialSubjectSchema.optional(),
    destination: destinationSchema,
    input: nonBlankStringSchema.pipe(z.string().max(32_000)),
    metadata: dispatchMetadataSchema.optional(),
  })
  .strict();

export type Requester = z.output<typeof requesterSchema>;

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

/** Thrown when a plugin tool rejects invalid model or user input. */
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
  requester?: Requester;
  sandbox: AgentPluginSandbox;
}

export interface BeforeToolExecuteHookContext extends AgentPluginContext {
  decision: AgentPluginDecision;
  env: AgentPluginEnv;
  requester?: Requester;
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
  /**
   * Capabilities of `channelId` — the raw conversation channel exposed to
   * this plugin. Recomputed from `channelId`, not from `destination`.
   */
  channelCapabilities?: {
    canAddReactions: boolean;
    canCreateCanvas: boolean;
    canPostToChannel: boolean;
  };
  /**
   * The raw Slack channel ID for this conversation — the DM or channel where
   * this turn is happening, without any assistant-context-source override.
   * Use this as the stable binding key for state scoped to a Slack conversation.
   * `channelCapabilities` describes this channel.
   */
  channelId?: string;
  /**
   * Opaque Junior conversation/session identity for this turn.
   * Interactive Slack turns use `slack:{channelId}:{threadTs}`.
   * Scheduled/API turns use an internal id such as `agent-dispatch:{id}`.
   * Do not parse as Slack unless the value starts with `slack:`.
   */
  conversationId?: string;
  credentialSubject?: AgentPluginCredentialSubject;
  /**
   * Runtime-owned destination suitable for future autonomous dispatch. For
   * Slack, this is the raw conversation channel, not a thread timestamp or
   * assistant-context source channel.
   */
  destination?: Destination;
  messageTs?: string;
  requester?: Requester;
  state: AgentPluginState;
  teamId?: string;
  threadTs?: string;
  userText?: string;
}

export type AgentPluginCredentialSubject = z.output<
  typeof agentPluginCredentialSubjectSchema
>;

export type Destination = z.output<typeof destinationSchema>;

export type DispatchOptions = z.output<typeof dispatchOptionsSchema>;

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

const agentPluginProviderNameSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
const agentPluginGrantNameSchema = z.string().regex(/^[a-z][a-z0-9.-]*$/);
const agentPluginGrantAccessSchema = z.union([
  z.literal("read"),
  z.literal("write"),
]);

/** Runtime schema for provider authorization a plugin may request. */
export const agentPluginAuthorizationSchema = z
  .object({
    provider: agentPluginProviderNameSchema,
    scope: nonBlankStringSchema.optional(),
    type: z.literal("oauth"),
  })
  .strict();

/** Runtime schema for a provider account attached to stored OAuth tokens. */
export const agentPluginProviderAccountSchema = z
  .object({
    id: nonBlankStringSchema,
    label: nonBlankStringSchema.optional(),
    url: nonBlankStringSchema.optional(),
  })
  .strict();

/** Runtime schema for a plugin-defined outbound credential grant. */
export const agentPluginGrantSchema = z
  .object({
    access: agentPluginGrantAccessSchema,
    name: agentPluginGrantNameSchema,
    reason: nonBlankStringSchema.optional(),
    requirements: z.array(nonBlankStringSchema).min(1).optional(),
  })
  .strict();

/** Runtime schema for plugin-issued header mutations. */
export const agentPluginCredentialHeaderTransformSchema = z
  .object({
    domain: z.string().min(1),
    headers: z
      .record(z.string(), z.string())
      .refine((headers) => Object.keys(headers).length > 0),
  })
  .strict();

/** Runtime schema for a short-lived plugin-issued credential lease. */
export const agentPluginCredentialLeaseSchema = z
  .object({
    account: agentPluginProviderAccountSchema.optional(),
    authorization: agentPluginAuthorizationSchema.optional(),
    expiresAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
    headerTransforms: z
      .array(agentPluginCredentialHeaderTransformSchema)
      .min(1),
  })
  .strict();

/** Runtime schema for the result returned by a plugin credential hook. */
export const agentPluginCredentialResultSchema = z.discriminatedUnion("type", [
  z
    .object({
      lease: agentPluginCredentialLeaseSchema,
      type: z.literal("lease"),
    })
    .strict(),
  z
    .object({
      authorization: agentPluginAuthorizationSchema.optional(),
      message: nonBlankStringSchema,
      type: z.literal("needed"),
    })
    .strict(),
  z
    .object({
      message: nonBlankStringSchema,
      type: z.literal("unavailable"),
    })
    .strict(),
]);

export type AgentPluginGrantAccess = z.output<
  typeof agentPluginGrantAccessSchema
>;

/** Provider authorization Junior can start when a plugin-owned grant is missing. */
export type AgentPluginAuthorization = z.output<
  typeof agentPluginAuthorizationSchema
>;

/** Interrupt sandbox egress so Junior can start provider authorization. */
export class EgressAuthRequired extends Error {
  authorization?: AgentPluginAuthorization;

  constructor(
    message: string,
    options?: {
      authorization?: AgentPluginAuthorization;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "EgressAuthRequired";
    this.authorization = options?.authorization;
  }
}

/** Provider account identity resolved by a plugin OAuth hook. */
export type AgentPluginProviderAccount = z.output<
  typeof agentPluginProviderAccountSchema
>;

/** Plugin-defined grant required before Junior can forward one outbound request. */
export type AgentPluginGrant = z.output<typeof agentPluginGrantSchema>;

/** Request details available while selecting the grant for sandbox egress. */
export interface AgentPluginEgressRequest {
  /** Capped request body text when the host exposes it for provider-specific grant classification. */
  bodyText?: string;
  method: string;
  url: string;
}

export interface EgressHookContext extends AgentPluginContext {
  request: AgentPluginEgressRequest;
}

export interface AgentPluginEgressResponse {
  /** Snapshot of upstream response headers; mutations do not affect pass-through. */
  headers: Headers;
  readText(maxBytes: number): Promise<string | undefined>;
  status: number;
}

export interface EgressResponseHookContext extends AgentPluginContext {
  grant: AgentPluginGrant;
  permissionDenied(message: string): void;
  request: Omit<AgentPluginEgressRequest, "bodyText">;
  response: AgentPluginEgressResponse;
}

/** Header mutations a plugin-issued credential lease may apply to owned domains. */
export type AgentPluginCredentialHeaderTransform = z.output<
  typeof agentPluginCredentialHeaderTransformSchema
>;

/** Short-lived credential headers issued by a plugin for a selected grant. */
export type AgentPluginCredentialLease = z.output<
  typeof agentPluginCredentialLeaseSchema
>;

export type AgentPluginCredentialResult = z.output<
  typeof agentPluginCredentialResultSchema
>;

export type AgentPluginCredentialActor =
  | {
      type: "system";
      id: string;
    }
  | {
      type: "user";
      userId: string;
    };

export interface AgentPluginResolvedCredentialUser {
  type: "user";
  userId: string;
}

export interface AgentPluginStoredTokens {
  account?: AgentPluginProviderAccount;
  accessToken: string;
  expiresAt?: number;
  refreshToken: string;
  scope?: string;
}

export interface AgentPluginUserTokenSlot {
  get(): Promise<AgentPluginStoredTokens | undefined>;
  set(tokens: AgentPluginStoredTokens): Promise<void>;
  userId: string;
}

export interface AgentPluginTokenStore {
  credentialSubject?: AgentPluginUserTokenSlot;
  currentUser?: AgentPluginUserTokenSlot;
}

export interface ResolveOAuthAccountHookContext extends AgentPluginContext {
  tokens: AgentPluginStoredTokens;
}

export interface IssueCredentialHookContext extends AgentPluginContext {
  actor: AgentPluginCredentialActor;
  credentialSubject?: AgentPluginResolvedCredentialUser;
  grant: AgentPluginGrant;
  tokens: AgentPluginTokenStore;
}

export interface AgentPluginHooks {
  sandboxPrepare?(ctx: SandboxPrepareHookContext): Promise<void> | void;
  beforeToolExecute?(ctx: BeforeToolExecuteHookContext): Promise<void> | void;
  grantForEgress?(
    ctx: EgressHookContext,
  ): Promise<AgentPluginGrant | undefined> | AgentPluginGrant | undefined;
  issueCredential?(
    ctx: IssueCredentialHookContext,
  ): Promise<AgentPluginCredentialResult> | AgentPluginCredentialResult;
  onEgressResponse?(ctx: EgressResponseHookContext): Promise<void> | void;
  resolveOAuthAccount?(
    ctx: ResolveOAuthAccountHookContext,
  ):
    | Promise<AgentPluginProviderAccount | undefined>
    | AgentPluginProviderAccount
    | undefined;
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
  /**
   * Treat a provider token response with `scope: ""` like an omitted scope and
   * fall back to the requested scope string when storing the token.
   *
   * Enable this only for providers whose token responses cannot report OAuth
   * scopes even though Junior needs a local requested-scope string for
   * reauthorization checks. The built-in GitHub App plugin enables this because
   * GitHub App user-to-server tokens always return an empty scope value — their
   * effective access is enforced by GitHub App permissions, installation
   * repository access, and the requesting user's own access, not OAuth scopes.
   *
   * Do not enable this for standard OAuth providers where an explicit empty
   * `scope` means the provider granted no scopes.
   */
  treatEmptyScopeAsUnreported?: boolean;
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

export type JuniorPluginCredentials = JuniorPluginOAuthBearerCredentials;

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
      "pluginConfig is no longer supported. Put runtime metadata in manifest and state prefixes on the plugin registration.",
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
