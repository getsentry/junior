import type {
  Actor,
  Identity,
  LocalInvocationContext,
  PluginContext,
  PluginEmbedder,
  PluginModel,
  SlackInvocationContext,
  User,
  WebInvocationContext,
} from "./context";
import type { PluginCredentialSubject } from "./credentials";
import type { PluginAnnotations } from "./annotations";
import type { SlackConversationLink } from "./operations";
import type {
  ResourceEventSubscriptionResult,
  SubscribableResource,
} from "./resource-events";
import type { PluginState } from "./state";
import { z, type ZodTypeAny } from "zod";

export interface PluginEnv {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export interface PluginDecision {
  deny(message: string): void;
  replaceInput(input: Record<string, unknown>): void;
}

/** Thrown when a plugin tool rejects invalid model or user input. */
export class PluginToolInputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PluginToolInputError";
  }
}

export interface PluginSandbox {
  juniorRoot: string;
  root: string;
  readFile(path: string): Promise<Uint8Array | null>;
  run(input: {
    args?: string[];
    cmd: string;
    cwd?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
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

export interface PluginEgress {
  /**
   * Fetch a provider URL with host-owned credentials.
   *
   * The runtime selects and injects credentials for `provider`; plugin code
   * owns the request shape and response handling. `operation` names the
   * provider action for grant selection and diagnostics.
   */
  fetch(input: {
    operation: string;
    provider: string;
    request: Request;
  }): Promise<Response>;
}

export const pluginToolContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      type: z.literal("image"),
      data: z.string(),
      mimeType: z.string(),
    })
    .strict(),
]);

/** Model-visible content returned by a plugin tool. */
export type PluginToolContent = z.output<typeof pluginToolContentSchema>;

/** Pi-native projection with model-facing content and canonical runtime details. */
export interface PluginToolOutputEnvelope<TDetails = unknown> {
  content: PluginToolContent[];
  details: TDetails;
}

export type PluginMcpContent = PluginToolContent;

/** Successful raw provider result returned to a plugin-owned wrapper tool. */
export type PluginMcpToolSuccess = {
  content: PluginMcpContent[];
  status: "success";
  structuredContent?: unknown;
};

/** Handled provider authorization pause with no provider result to consume. */
export type PluginMcpAuthorizationPending = {
  status: "authorization_pending";
};

/** Definitive provider rejection; transport and session failures still throw. */
export type PluginMcpToolError = {
  message: string;
  status: "error";
};

export type PluginMcpToolResult =
  | PluginMcpAuthorizationPending
  | PluginMcpToolError
  | PluginMcpToolSuccess;

/** Access to this plugin's hosted MCP provider without exposing credentials. */
export interface PluginMcp {
  /**
   * Call a provider tool declared in `wrappedTools`.
   *
   * The host activates the provider when needed. Successful calls return the
   * provider's original content, provider rejections return an error result,
   * and authorization pauses return no tool content. Transport failures throw.
   */
  callTool(input: {
    arguments?: Record<string, unknown>;
    name: string;
    toolCallId?: string;
  }): Promise<PluginMcpToolResult>;
  /**
   * Activate the provider before wrapper-owned state changes.
   *
   * Ordinary wrappers can call `callTool` directly. Durable mutation wrappers
   * may prepare first so an initial authorization pause happens before they
   * record pending work.
   */
  prepare(): Promise<"authorization_pending" | "ready">;
}

/**
 * Provider-owned, repeatable repository preparation for a Workspace Sandbox.
 * Implementations should refresh complete checkouts and replace missing or
 * partial ones.
 */
export interface WorkspacePrepareHookContext extends PluginContext {
  repos: Array<{
    path: string;
    repo: string;
  }>;
  sandbox: PluginSandbox;
}

export interface SandboxPrepareHookContext extends PluginContext {
  actor?: Actor;
  sandbox: PluginSandbox;
}

export interface BeforeToolExecuteHookContext extends PluginContext {
  decision: PluginDecision;
  env: PluginEnv;
  actor?: Actor;
  /** All actors who contributed instructions to the run so far; see `multi-actor-runs.md`. */
  actors?: Actor[];
  tool: {
    input: Record<string, unknown>;
    name: string;
  };
}

/**
 * Context for post-success MCP tool processing.
 *
 * Runs after a hosted MCP tool succeeds on the model-facing path. Use for
 * junior-owned side effects such as conversation annotations without replacing
 * the provider tool contract.
 */
export interface AfterMcpToolHookContext extends PluginContext {
  /**
   * Opaque Junior conversation/session identity for this turn.
   * Interactive Slack turns use `slack:{channelId}:{threadTs}`.
   */
  conversationId?: string;
  annotations?: PluginAnnotations;
  result: {
    structuredContent?: unknown;
  };
  tool: {
    arguments: Record<string, unknown>;
    /** Provider-local MCP tool name, for example `save_issue`. */
    name: string;
  };
}

export interface PluginToolExecuteOptions {
  /**
   * @deprecated Internal compatibility escape hatch for legacy tool bridges.
   * Plugin tools should use typed input fields and runtime hook context instead.
   */
  experimental_context?: unknown;
  /** Abort when the owning agent tool call is cancelled or times out. */
  signal?: AbortSignal;
  /** Stable runtime tool-call id; durable create tools should derive idempotency keys from it. */
  toolCallId?: string;
}

export const pluginToolContinuationSchema = z
  .object({
    arguments: z.record(z.string(), z.unknown()),
    reason: z.string().min(1).optional(),
  })
  .strict();

/** Shared optional fields for canonical plugin tool outputs. */
export const pluginToolOutputSchema = z
  .object({
    target: z.string().min(1).optional(),
    truncated: z.boolean().optional(),
    continuation: pluginToolContinuationSchema.optional(),
  })
  .passthrough();

export type PluginToolOutput = z.output<typeof pluginToolOutputSchema>;

export type PluginToolExecute<TInput = unknown, TOutput = unknown> = {
  bivarianceHack(
    input: TInput,
    options: PluginToolExecuteOptions,
  ): Promise<TOutput> | TOutput;
}["bivarianceHack"];

/**
 * Tool-declared approval mode.
 *
 * `auto` delegates to core policy, `review` enters Guardian review, and
 * `approve` permits execution without review. Plugin tool helpers normalize
 * omission to `auto`.
 *
 * Core resolves the effective mode immediately before execution.
 */
export const toolApprovalModeSchema = z.enum(["auto", "review", "approve"]);

export type ToolApprovalMode = z.output<typeof toolApprovalModeSchema>;

/**
 * Reviewer signals describing a tool's side-effect behavior.
 *
 * These hints follow the MCP tool annotation contract. Guardian may use
 * them as signals, but they never grant authority or override deterministic
 * authorization.
 */
export interface ToolAnnotations {
  [key: string]: unknown;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  readOnlyHint?: boolean;
  title?: string;
}

export const REQUIRED_TOOL_ANNOTATION_KEYS = [
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
  "readOnlyHint",
] as const;

export type RequiredToolAnnotationKey =
  (typeof REQUIRED_TOOL_ANNOTATION_KEYS)[number];

/** Return behavioral annotation keys that a tool did not declare. */
export function missingToolAnnotationKeys(
  annotations: ToolAnnotations | undefined,
): RequiredToolAnnotationKey[] {
  return REQUIRED_TOOL_ANNOTATION_KEYS.filter(
    (key) => typeof annotations?.[key] !== "boolean",
  );
}

/**
 * Canonical approval metadata declared by core and plugin tools.
 */
export interface ToolApprovalMetadata<TInput = unknown> {
  /** Optional declared approval mode; the owning tool boundary selects defaults. */
  approvalMode?: ToolApprovalMode;
  annotations?: ToolAnnotations;
  /**
   * Describe the reviewed semantic action for the review request.
   *
   * Core owns authoritative tool, actor, source, destination, conversation,
   * credential, and input data. This description adds domain-specific context
   * only and is never an authorization grant.
   */
  describeProposal?(input: TInput): string;
}

export interface PluginToolDefinition<
  TInput = unknown,
  TOutput = unknown,
  TExecuteOutput = TOutput,
> extends ToolApprovalMetadata<TInput> {
  description: string;
  executionMode?: unknown;
  inputSchema: unknown;
  outputSchema?: unknown;
  /**
   * Select result fields that are safe to retain in private traces.
   * Returning `undefined` suppresses private result capture.
   */
  privateTraceResult?(result: TOutput): unknown;
  prepareArguments?: (args: unknown) => TInput;
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
  execute?: PluginToolExecute<TInput, TExecuteOutput>;
}

type ZodPluginToolDefinition<
  TInputSchema extends ZodTypeAny,
  TOutputSchema extends ZodTypeAny,
  TExecuteResult extends
    | z.input<TOutputSchema>
    | PluginToolOutputEnvelope<z.input<TOutputSchema>>,
> = Omit<
  PluginToolDefinition<z.output<TInputSchema>, z.output<TOutputSchema>>,
  "inputSchema" | "outputSchema" | "prepareArguments" | "execute"
> & {
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  prepareArguments?: (args: unknown) => z.input<TInputSchema>;
  execute?: (
    input: z.output<TInputSchema>,
    options: PluginToolExecuteOptions,
  ) => Promise<TExecuteResult> | TExecuteResult;
};

type ParsedPluginToolExecuteResult<TOutputSchema extends ZodTypeAny, TResult> =
  TResult extends PluginToolOutputEnvelope<unknown>
    ? PluginToolOutputEnvelope<z.output<TOutputSchema>>
    : z.output<TOutputSchema>;

function isPluginToolOutputEnvelope(
  value: unknown,
): value is PluginToolOutputEnvelope<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as { content?: unknown }).content) &&
    "details" in value
  );
}

function formatZodPath(path: readonly PropertyKey[]): string {
  return path.length > 0 ? path.map(String).join(".") : "root";
}

function formatPluginToolInputError(error: z.ZodError): string {
  const details = error.issues
    .slice(0, 5)
    .map((issue) => `${formatZodPath(issue.path)}: ${issue.message}`)
    .join("; ");
  return `Invalid tool arguments: ${details || "input did not match schema"}`;
}

function parsePluginToolInput<TInputSchema extends ZodTypeAny>(
  schema: TInputSchema,
  args: unknown,
): z.output<TInputSchema> {
  const result = schema.safeParse(args);
  if (!result.success) {
    throw new PluginToolInputError(formatPluginToolInputError(result.error), {
      cause: result.error,
    });
  }
  return result.data;
}

function createZodTool<
  TInputSchema extends ZodTypeAny,
  TOutputSchema extends ZodTypeAny,
  TExecuteResult extends
    | z.input<TOutputSchema>
    | PluginToolOutputEnvelope<z.input<TOutputSchema>>,
>(
  definition: ZodPluginToolDefinition<
    TInputSchema,
    TOutputSchema,
    TExecuteResult
  >,
  helperName: "definePluginTool" | "zodTool",
): PluginToolDefinition<
  z.output<TInputSchema>,
  z.output<TOutputSchema>,
  ParsedPluginToolExecuteResult<TOutputSchema, TExecuteResult>
> {
  const { inputSchema, outputSchema, prepareArguments, execute, ...tool } =
    definition;
  let modelInputSchema: unknown;
  let modelOutputSchema: unknown;
  try {
    modelInputSchema = z.toJSONSchema(inputSchema);
  } catch (error) {
    throw new TypeError(
      `${helperName}() inputSchema must be representable as JSON Schema.`,
      { cause: error },
    );
  }
  try {
    modelOutputSchema = z.toJSONSchema(outputSchema);
  } catch (error) {
    throw new TypeError(
      `${helperName}() outputSchema must be representable as JSON Schema.`,
      { cause: error },
    );
  }
  return {
    ...tool,
    approvalMode: tool.approvalMode ?? "auto",
    inputSchema: modelInputSchema,
    outputSchema: modelOutputSchema,
    prepareArguments(args) {
      return parsePluginToolInput(
        inputSchema,
        prepareArguments ? prepareArguments(args) : args,
      );
    },
    ...(execute
      ? {
          async execute(input, options) {
            const result = await execute(
              input as z.output<TInputSchema>,
              options,
            );
            if (isPluginToolOutputEnvelope(result)) {
              return {
                content: z.array(pluginToolContentSchema).parse(result.content),
                details: outputSchema.parse(result.details),
              };
            }
            return outputSchema.parse(result);
          },
        }
      : undefined),
  } as PluginToolDefinition<
    z.output<TInputSchema>,
    z.output<TOutputSchema>,
    ParsedPluginToolExecuteResult<TOutputSchema, TExecuteResult>
  >;
}

/** Define a plugin tool with Zod input parsing and validated structured results. */
export function zodTool<
  TInputSchema extends ZodTypeAny,
  TOutputSchema extends ZodTypeAny,
  TExecuteResult extends
    | z.input<TOutputSchema>
    | PluginToolOutputEnvelope<z.input<TOutputSchema>>,
>(
  definition: ZodPluginToolDefinition<
    TInputSchema,
    TOutputSchema,
    TExecuteResult
  >,
): PluginToolDefinition<
  z.output<TInputSchema>,
  z.output<TOutputSchema>,
  ParsedPluginToolExecuteResult<TOutputSchema, TExecuteResult>
> {
  return createZodTool(definition, "zodTool");
}

/** Define a plugin tool with Zod input parsing and the structured result contract. */
export function definePluginTool<
  TInputSchema extends ZodTypeAny,
  TOutputSchema extends ZodTypeAny,
  TExecuteResult extends
    | z.input<TOutputSchema>
    | PluginToolOutputEnvelope<z.input<TOutputSchema>>,
>(
  definition: ZodPluginToolDefinition<
    TInputSchema,
    TOutputSchema,
    TExecuteResult
  >,
): PluginToolDefinition<
  z.output<TInputSchema>,
  z.output<TOutputSchema>,
  ParsedPluginToolExecuteResult<TOutputSchema, TExecuteResult>
> {
  return createZodTool(definition, "definePluginTool");
}

export interface SlackToolRegistrationHookContext {
  /**
   * Capabilities of the source Slack conversation exposed to this plugin.
   * Recomputed from `source.channelId`, not from `destination`.
   */
  channelCapabilities: {
    canAddReactions: boolean;
    canCreateCanvas: boolean;
    canPostToChannel: boolean;
  };
  /** Host-owned link to this conversation, preferring the dashboard when enabled. */
  conversationLink?: SlackConversationLink;
  credentialSubject?: Extract<
    PluginCredentialSubject,
    { allowedWhen: "private-direct-conversation" }
  >;
}

export interface PluginResourceEventToolContext {
  /** Whether this invocation can create a working resource subscription. */
  canSubscribe: boolean;
  /** Create a temporary resource subscription for the current conversation. */
  subscribe(input: {
    events: string[];
    intent: string;
    resource: SubscribableResource;
  }): Promise<ResourceEventSubscriptionResult>;
}

export interface PluginWorkspaceToolContext {
  /** Find named Workspaces that include one provider repository. */
  findByRepository(input: {
    provider: string;
    repo: string;
  }): Promise<string[]>;
}

interface BaseToolRegistrationHookContext extends PluginContext {
  /**
   * Opaque Junior conversation/session identity for this turn.
   * Interactive Slack turns use `slack:{channelId}:{threadTs}`.
   * Scheduled/web turns use an internal id such as `agent-dispatch:{id}`.
   * Do not parse as Slack unless the value starts with `slack:`.
   */
  conversationId?: string;
  annotations?: PluginAnnotations;
  embedder: PluginEmbedder;
  egress: PluginEgress;
  mcp?: PluginMcp;
  model: PluginModel;
  resourceEvents: PluginResourceEventToolContext;
  /** Sandbox filesystem and command capability for plugin-owned workspace tools. */
  sandbox: PluginSandbox;
  state: PluginState;
  users: {
    /** Resolve the current actor's stored identity and linked user. */
    resolveActor(): Promise<{ identity: Identity; user?: User } | undefined>;
  };
  userText?: string;
  workspaces: PluginWorkspaceToolContext;
}

interface SlackToolRegistrationContext
  extends BaseToolRegistrationHookContext, SlackInvocationContext {
  slack: SlackToolRegistrationHookContext;
}

interface LocalToolRegistrationContext
  extends BaseToolRegistrationHookContext, LocalInvocationContext {
  slack?: never;
}

interface WebToolRegistrationContext
  extends BaseToolRegistrationHookContext, WebInvocationContext {
  slack?: never;
}

export type ToolRegistrationHookContext =
  | LocalToolRegistrationContext
  | SlackToolRegistrationContext
  | WebToolRegistrationContext;
