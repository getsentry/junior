import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { Kind, type Static, type TSchema } from "@sinclair/typebox";
import type { ToolExecutionMode } from "@earendil-works/pi-agent-core";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";

/**
 * Tool definition boundary for Pi-facing agent tools.
 */
export interface JsonSchemaObject {
  [key: string]: unknown;
}
export type ToolInputSchema = TSchema | JsonSchemaObject;

export type ToolExposure = "direct" | "deferred" | "modelOnly" | "hidden";

export interface ToolExecuteOptions {
  experimental_context?: unknown;
  signal?: AbortSignal;
  conversationPrivacy?: ConversationPrivacy;
  toolCallId?: string;
}

interface BaseToolDefinition<TInput, TInputSchema extends ToolInputSchema> {
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
  annotations?: ToolAnnotations;
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
export interface AnyToolDefinition {
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
  annotations?: ToolAnnotations;
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
}

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
