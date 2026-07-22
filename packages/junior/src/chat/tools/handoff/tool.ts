import { z } from "zod";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

export const HANDOFF_TOOL_NAME = "handoff";

/** Create the runtime control for an in-place execution-profile switch. */
export function createHandoffTool(
  handoff: NonNullable<ToolRuntimeContext["handoff"]>,
) {
  const profileSchema = z.enum(handoff.profiles);
  const handoffResultSchema = juniorToolResultSchema.extend({
    model_profile: profileSchema,
  });
  const profileNames = handoff.profiles
    .map((profile) => `\`${profile}\``)
    .join(", ");
  return zodTool({
    description: `Switch execution profiles and continue the same task with the same workspace and tools. Available profiles: ${profileNames}. Call this as the only tool in the assistant message.`,
    executionMode: "sequential",
    inputSchema: z
      .object({
        profile: profileSchema.describe("Execution profile to switch to"),
      })
      .strict(),
    outputSchema: handoffResultSchema,
    execute: async (input, options) => {
      const profile = input.profile;
      if (!options.toolCallId) {
        throw new ToolInputError("Handoff requires an active tool call ID");
      }
      await handoff.execute(profile, {
        ...(options.signal ? { signal: options.signal } : {}),
        toolCallId: options.toolCallId,
      });
      return {
        ok: true,
        status: "success" as const,
        model_profile: profile,
      };
    },
  });
}
