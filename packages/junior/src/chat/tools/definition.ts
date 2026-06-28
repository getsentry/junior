import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { Static, TSchema } from "@sinclair/typebox";
import type { ToolExecutionMode } from "@earendil-works/pi-agent-core";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";

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
    options: {
      experimental_context?: unknown;
      signal?: AbortSignal;
      conversationPrivacy?: ConversationPrivacy;
      toolCallId?: string;
    },
  ) => Promise<unknown> | unknown;
}

/** Infer execute parameter types from the inputSchema via generic binding. */
export function tool<TInputSchema extends TSchema>(
  definition: ToolDefinition<TInputSchema>,
): ToolDefinition<TInputSchema> {
  return definition;
}
