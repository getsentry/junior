// The host code that core runs around the tool calls of a core Turn step.
import { reviewToolActions } from "@/chat/guardian/gate";
import { capToolResult } from "@/chat/tool-support/result-cap";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import type { AnyToolDefinition } from "@/chat/tool-support/definition";
import type { ToolExecutionHooks, ToolResult } from "@/core/tool";

/**
 * Builds the tool hooks of one step. Core has no Guardian yet, so a call that
 * needs review gets main's "review unavailable" error and does not run.
 * Calls that need no review run.
 */
export function turnToolHooks(options: {
  /** Main's definition of each of the step's tools, by name. */
  tools: Map<string, AnyToolDefinition>;
  /** Where a cut result's full text goes. */
  workspace: Pick<SandboxWorkspace, "writeFiles">;
}): ToolExecutionHooks {
  return {
    async beforeBatch(calls, signal) {
      // Each call alone, as main reviews a direct call. One batch of more than
      // MAX_TOOL_ACTION_BATCH would also reject the calls that need no review.
      const reviews = await Promise.all(
        // oxlint-disable-next-line junior/bounded-fan-out -- One review per call of one model message.
        calls.map(async (call) => {
          const tool = options.tools.get(call.name);
          if (!tool) {
            throw new Error(`Tool ${call.name} has no definition`);
          }
          const action = {
            toolCallId: call.id,
            toolName: call.name,
            tool,
            input: call.arguments,
          };
          const results = await reviewToolActions([action], undefined, signal);
          return [call.id, results.get(call.id)] as const;
        }),
      );
      return new Map(
        reviews.flatMap(([callId, review]): [string, ToolResult][] =>
          review && !review.allowed
            ? [
                [
                  callId,
                  {
                    content: [{ type: "text", text: review.error.message }],
                    isError: true,
                  },
                ],
              ]
            : [],
        ),
      );
    },
    afterCall: (call, result) =>
      capToolResult(result, {
        toolCallId: call.id,
        workspace: options.workspace,
      }),
  };
}
