import { Kind, type Static, type TSchema } from "@sinclair/typebox";
import type { ToolExecutionMode } from "@earendil-works/pi-agent-core";
import type { ToolAnnotations, ToolExposure } from "@sentry/junior-plugin-api";
import * as z from "zod";
import type { Action } from "@/chat/guardian/guardian";
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
  /**
   * What a remote MCP server says about its tool. Untrusted hints for
   * Guardian: they never skip review (`review-by-default`).
   */
  serverHints?: ToolAnnotations;
  /** Set by core from the plugin manifest, never from the MCP server. */
  skipReview?: true;
  description?: string;
  name?: string;
  source?: {
    description: string;
    id: string;
  };
}

/**
 * Tool-declared approval mode.
 *
 * `auto` delegates to core policy, `review` enters Guardian review, and
 * `approve` permits execution without review. Every plugin tool is `auto`.
 *
 * Core resolves the effective mode immediately before execution.
 */
export const toolApprovalModeSchema = z.enum(["auto", "review", "approve"]);

export type ToolApprovalMode = z.output<typeof toolApprovalModeSchema>;

/** Approval metadata that core and plugin tools declare. */
export interface ToolApprovalMetadata {
  /** Declared approval mode. The owning tool boundary selects defaults. */
  approvalMode?: ToolApprovalMode | undefined;
  annotations?: ToolAnnotations;
}

/**
 * What a tool's `guardian` tells Guardian about one call. Only core tools
 * write a `summary`.
 */
export type ActionDescription = Pick<
  Action,
  "target" | "toolDecision" | "summary"
>;

export interface ToolExecuteOptions {
  experimental_context?: unknown;
  signal?: AbortSignal;
  conversationPrivacy?: ConversationPrivacy;
  toolCallId?: string;
}

interface BaseToolDefinition<
  TInput,
  TInputSchema extends ToolInputSchema,
> extends ToolApprovalMetadata {
  /**
   * Describe one call for Guardian from stored records
   * (`facts-from-junior` in `design/guardian.md`).
   */
  guardian?(
    input: TInput,
  ): ActionDescription | undefined | Promise<ActionDescription | undefined>;
  /** The current Guardian's line for one call. Only `current.ts` reads it. */
  describeProposal?(input: TInput): string;
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
 * Schema-erased view for mixed registries, after Pi validates tool input.
 */
export interface AnyToolDefinition extends ToolApprovalMetadata {
  /**
   * Describe one call for Guardian. Core binds a plugin tool's hook to the
   * Turn's stored facts (`facts-from-junior` in `design/guardian.md`).
   */
  guardian?(
    input: unknown,
  ): ActionDescription | undefined | Promise<ActionDescription | undefined>;
  /** The current Guardian's line for one call. Only `current.ts` reads it. */
  describeProposal?(input: unknown): string;
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
  outputSchema?: ToolInputSchema | undefined;
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

/** Name-indexed mixed tool definitions that the agent runtime accepts. */
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
