import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { Static, TSchema } from "@sinclair/typebox";
import type { ToolExecutionMode } from "@earendil-works/pi-agent-core";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";

export interface ToolExecuteOptions {
  experimental_context?: unknown;
  signal?: AbortSignal;
  conversationPrivacy?: ConversationPrivacy;
  toolCallId?: string;
}

export interface ToolDefinition<TInputSchema extends TSchema = TSchema> {
  /** Stable internal owner-qualified identity for plugin-contributed tools. */
  identity?: {
    id: string;
    name: string;
    plugin: string;
  };
  description: string;
  inputSchema: TInputSchema;
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
  prepareArguments?: (args: unknown) => Static<TInputSchema>;
  executionMode?: ToolExecutionMode;
  execute?: (
    input: Static<TInputSchema>,
    options: ToolExecuteOptions,
  ) => Promise<unknown> | unknown;
}

/**
 * Schema-erased view for heterogeneous registries after Pi validates tool input.
 */
export interface AnyToolDefinition extends Omit<
  ToolDefinition<TSchema>,
  "execute" | "prepareArguments"
> {
  execute?(
    input: unknown,
    options: ToolExecuteOptions,
  ): Promise<unknown> | unknown;
  prepareArguments?(args: unknown): unknown;
}

/** Infer execute parameter types from the inputSchema via generic binding. */
export function tool<TInputSchema extends TSchema>(
  definition: ToolDefinition<TInputSchema>,
): ToolDefinition<TInputSchema> {
  return definition;
}
