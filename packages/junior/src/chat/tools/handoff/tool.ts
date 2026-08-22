import { z } from "zod";
import { modelProfileSchema } from "@/chat/model-profile";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

export const HANDOFF_TOOL_NAME = "handoff";

/** Create the tool that switches the active model profile. */
export function createHandoffTool(
  handoff: NonNullable<ToolRuntimeContext["handoff"]>,
) {
  const profileSchema = z.enum(handoff.profiles);
  const handoffResultSchema = juniorToolOutputSchema.extend({
    model_profile: modelProfileSchema,
  });
  const profileNames = handoff.profiles
    .map((profile) => `\`${profile}\``)
    .join(", ");
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description: `Switch to another model profile and continue the same task. Profiles: ${profileNames}. Call this as the only tool.`,
    executionMode: "sequential",
    inputSchema: z
      .object({
        profile: profileSchema.describe("Target model profile"),
      })
      .strict(),
    outputSchema: handoffResultSchema,
    execute: async (input, options) => {
      const profile = input.profile;
      if (!options.toolCallId) {
        throw new ToolInputError("Handoff requires an active tool call ID");
      }
      await handoff.execute(profile, {
        ...(options.signal ? { signal: options.signal } : undefined),
        toolCallId: options.toolCallId,
      });
      return {
        model_profile: profile,
      };
    },
  });
}
