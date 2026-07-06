import type {
  PluginContext,
  LocalInvocationContext,
  PluginEmbedder,
  PluginModel,
  Requester,
  SlackInvocationContext,
} from "./context";
import type { PluginCredentialSubject } from "./credentials";
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

export interface SandboxPrepareHookContext extends PluginContext {
  requester?: Requester;
  sandbox: PluginSandbox;
}

export interface BeforeToolExecuteHookContext extends PluginContext {
  decision: PluginDecision;
  env: PluginEnv;
  requester?: Requester;
  tool: {
    input: Record<string, unknown>;
    name: string;
  };
}

export interface PluginToolExecuteOptions {
  /**
   * @deprecated Internal compatibility escape hatch for legacy tool bridges.
   * Plugin tools should use typed input fields and runtime hook context instead.
   */
  experimental_context?: unknown;
  /** Stable runtime tool-call id; durable create tools should derive idempotency keys from it. */
  toolCallId?: string;
}

export type PluginToolExecute<TInput = unknown> = {
  bivarianceHack(
    input: TInput,
    options: PluginToolExecuteOptions,
  ): Promise<unknown> | unknown;
}["bivarianceHack"];

export interface PluginToolDefinition<TInput = unknown> {
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
  execute?: PluginToolExecute<TInput>;
}

type ZodPluginToolDefinition<TInputSchema extends ZodTypeAny> = Omit<
  PluginToolDefinition<z.output<TInputSchema>>,
  "inputSchema" | "prepareArguments"
> & {
  inputSchema: TInputSchema;
  prepareArguments?: (args: unknown) => z.input<TInputSchema>;
};

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

/**
 * Define a plugin tool with JSON-Schema-representable Zod input parsing.
 */
export function definePluginTool<TInputSchema extends ZodTypeAny>(
  definition: ZodPluginToolDefinition<TInputSchema>,
): PluginToolDefinition<z.output<TInputSchema>> {
  const { inputSchema, prepareArguments, ...tool } = definition;
  let modelInputSchema: unknown;
  try {
    modelInputSchema = z.toJSONSchema(inputSchema);
  } catch (error) {
    throw new TypeError(
      "definePluginTool() inputSchema must be representable as JSON Schema.",
      { cause: error },
    );
  }
  return {
    ...tool,
    inputSchema: modelInputSchema,
    prepareArguments(args) {
      return parsePluginToolInput(
        inputSchema,
        prepareArguments ? prepareArguments(args) : args,
      );
    },
  };
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
  credentialSubject?: PluginCredentialSubject;
}

interface BaseToolRegistrationHookContext extends PluginContext {
  /**
   * Opaque Junior conversation/session identity for this turn.
   * Interactive Slack turns use `slack:{channelId}:{threadTs}`.
   * Scheduled/API turns use an internal id such as `agent-dispatch:{id}`.
   * Do not parse as Slack unless the value starts with `slack:`.
   */
  conversationId?: string;
  embedder: PluginEmbedder;
  egress: PluginEgress;
  model: PluginModel;
  state: PluginState;
  userText?: string;
}

interface SlackToolRegistrationContext
  extends BaseToolRegistrationHookContext, SlackInvocationContext {
  slack: SlackToolRegistrationHookContext;
}

interface LocalToolRegistrationContext
  extends BaseToolRegistrationHookContext, LocalInvocationContext {
  slack?: never;
}

export type ToolRegistrationHookContext =
  | LocalToolRegistrationContext
  | SlackToolRegistrationContext;
