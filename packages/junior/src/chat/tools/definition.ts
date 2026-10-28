import { Kind, type Static, type TSchema } from "@sinclair/typebox";
import type { ToolExecutionMode } from "@earendil-works/pi-agent-core";
import type {
  ToolAnnotations,
  ToolApprovalMetadata,
  ToolExposure,
} from "@sentry/junior-plugin-api";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

/**
 * Tool definition boundary for Pi-facing agent tools.
 */
export interface JsonSchemaObject {
  [key: string]: unknown;
}
export type ToolInputSchema = TSchema | JsonSchemaObject;

export type { ToolExposure };

/** Invocation-specific approval metadata resolved by a trusted host bridge. */
export interface ToolApprovalResolution {
  annotations?: ToolAnnotations;
  description?: string;
  name?: string;
  source?: {
    description: string;
    id: string;
  };
}

export interface ToolExecuteOptions {
  experimental_context?: unknown;
  signal?: AbortSignal;
  conversationPrivacy?: ConversationPrivacy;
  toolCallId?: string;
}

interface BaseToolDefinition<
  TInput,
  TInputSchema extends ToolInputSchema,
> extends ToolApprovalMetadata<TInput> {
  /** Stable internal owner-qualified identity for plugin-contributed tools. */
  identity?: {
    id: string;
    name: string;
    plugin: string;
  };
  /** Stable model-facing catalog grouping for deferred tool discovery. */
  source?: {
    description: string;
    id: string;
  };
  /** Why the current Turn cannot run this tool. Set it with `disableTools`. */
  disabledReason?: string;
  description: string;
  exposure?: ToolExposure;
  inputSchema: TInputSchema;
  outputSchema?: ToolInputSchema;
  privateTraceResult?(result: unknown): unknown;
  /**
   * @deprecated Put tool-selection and usage guidance directly in `description`
   * and parameter descriptions. Retained for plugin compatibility; may be
   * removed in a future major version.
   */
  promptSnippet?: string;
  /**
   * @deprecated Put tool-selection and usage guidance directly in `description`
   * and parameter descriptions. Retained for plugin compatibility; may be
   * removed in a future major version.
   */
  promptGuidelines?: string[];
  prepareArguments?: (args: unknown) => TInput;
  /**
   * Return trusted host metadata for the exact dispatched action.
   *
   * Descriptions and annotations inform review; they do not grant authority.
   * This projection runs before action review and must not activate providers
   * or perform other external side effects.
   */
  resolveApprovalMetadata?(
    input: TInput,
  ):
    | Promise<ToolApprovalResolution | undefined>
    | ToolApprovalResolution
    | undefined;
  executionMode?: ToolExecutionMode;
  execute?: (
    input: TInput,
    options: ToolExecuteOptions,
  ) => Promise<unknown> | unknown;
}

export interface ToolDefinition<
  TInputSchema extends TSchema = TSchema,
> extends BaseToolDefinition<Static<TInputSchema>, TInputSchema> {}

/**
 * Schema-erased view for heterogeneous registries after Pi validates tool input.
 */
export interface AnyToolDefinition extends ToolApprovalMetadata {
  /** Stable internal owner-qualified identity for plugin-contributed tools. */
  identity?: {
    id: string;
    name: string;
    plugin: string;
  };
  /** Stable model-facing catalog grouping for deferred tool discovery. */
  source?: {
    description: string;
    id: string;
  };
  /** Why the current Turn cannot run this tool. Set it with `disableTools`. */
  disabledReason?: string;
  description: string;
  exposure?: ToolExposure;
  inputSchema: ToolInputSchema;
  outputSchema?: ToolInputSchema;
  privateTraceResult?(result: unknown): unknown;
  /**
   * @deprecated Put tool-selection and usage guidance directly in `description`
   * and parameter descriptions. Retained for plugin compatibility; may be
   * removed in a future major version.
   */
  promptSnippet?: string;
  /**
   * @deprecated Put tool-selection and usage guidance directly in `description`
   * and parameter descriptions. Retained for plugin compatibility; may be
   * removed in a future major version.
   */
  promptGuidelines?: string[];
  executionMode?: ToolExecutionMode;
  execute?(
    input: unknown,
    options: ToolExecuteOptions,
  ): Promise<unknown> | unknown;
  prepareArguments?(args: unknown): unknown;
  /**
   * Return trusted host metadata for the exact dispatched action.
   *
   * Descriptions and annotations inform review; they do not grant authority.
   * This projection runs before action review and must not activate providers
   * or perform other external side effects.
   */
  resolveApprovalMetadata?(
    input: unknown,
  ):
    | Promise<ToolApprovalResolution | undefined>
    | ToolApprovalResolution
    | undefined;
}

/** Name-indexed heterogeneous tool definitions accepted by the agent runtime. */
export type ToolRegistry = Record<string, AnyToolDefinition>;

/** Distinguish legacy TypeBox schemas from JSON Schema projected from Zod. */
export function isTypeBoxInputSchema(
  schema: ToolInputSchema,
): schema is TSchema {
  return typeof schema === "object" && schema !== null && Kind in schema;
}

/** Infer execute parameter types from the inputSchema via generic binding. */
export function tool<TInputSchema extends TSchema>(
  definition: ToolDefinition<TInputSchema>,
): ToolDefinition<TInputSchema> {
  return definition;
}

/** Tool error text for a call to a tool that is disabled in this Turn. */
export function disabledToolMessage(toolName: string, reason: string): string {
  return `${toolName} is disabled in this Turn. ${reason} Do not call it again in this Turn.`;
}

/**
 * Disable tools for this Turn without removing them from the tool list.
 *
 * The tool adapter rejects their calls, and the Turn context lists them. An
 * unset reason keeps the tools enabled.
 */
export function disableTools(
  tools: ToolRegistry,
  reason: string | undefined,
): ToolRegistry {
  if (!reason) return tools;
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      { ...tool, disabledReason: reason },
    ]),
  );
}

const READ_ONLY_REASON =
  "This child agent is read-only. It can read and use its own Sandbox, but it cannot change anything outside it.";

/** Read-only or Sandbox-local actions are allowed in a read-only run. */
function isReadOnlyAction(annotations: ToolAnnotations | undefined): boolean {
  return (
    annotations?.readOnlyHint === true || annotations?.openWorldHint === false
  );
}

/**
 * Keep only read-only and Sandbox-local actions. Other tools stay in the tool
 * list, disabled like `disableTools`. A dispatcher, such as `callMcpTool`,
 * names its real action for each input, so it checks that action per call.
 */
export function restrictToReadOnlyTools(tools: ToolRegistry): ToolRegistry {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const { execute, resolveApprovalMetadata } = tool;
      if (!resolveApprovalMetadata || !execute) {
        return [
          name,
          isReadOnlyAction(tool.annotations)
            ? tool
            : { ...tool, disabledReason: READ_ONLY_REASON },
        ];
      }
      return [
        name,
        {
          ...tool,
          execute: async (input: unknown, options: ToolExecuteOptions) => {
            const resolved = await resolveApprovalMetadata(input);
            if (!isReadOnlyAction(resolved?.annotations ?? tool.annotations)) {
              throw new ToolInputError(
                disabledToolMessage(resolved?.name ?? name, READ_ONLY_REASON),
              );
            }
            return await execute(input, options);
          },
        },
      ];
    }),
  );
}
