import { Kind, type Static, type TSchema } from "@sinclair/typebox";
import type { ToolExecutionMode } from "@earendil-works/pi-agent-core";
import type {
  ToolAnnotations,
  ToolApprovalMetadata,
  ToolExposure,
} from "@sentry/junior-plugin-api";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";

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
