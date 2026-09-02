import { z } from "zod";
import {
  formatModelProfileSteering,
  modelProfileSchema,
} from "@/chat/model-profile";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

export const HANDOFF_TOOL_NAME = "handoff";

function formatHandoffProfileCatalog(
  handoff: NonNullable<ToolRuntimeContext["handoff"]>,
): string {
  return handoff.profiles
    .map((profile) => {
      const description = handoff.profileDescriptions?.[profile]?.trim();
      const entry = formatModelProfileSteering(
        profile,
        description ? { modelId: profile, description } : { modelId: profile },
      );
      return `- ${entry}`;
    })
    .join("\n");
}

/** Create the tool that switches the active model profile. */
export function createHandoffTool(
  handoff: NonNullable<ToolRuntimeContext["handoff"]>,
) {
  const profileSchema = z.enum(handoff.profiles);
  const handoffResultSchema = juniorToolOutputSchema.extend({
    model_profile: modelProfileSchema,
  });
  const profileCatalog = formatHandoffProfileCatalog(handoff);
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description: [
      [
        "Switch to another model profile and continue the same task.",
        "Use this before substantive work when a listed profile clearly fits better than the current one.",
        "Choose by the profile description, not by the name alone.",
        "Do not switch merely because the task mentions code.",
        "Call this as the only tool.",
      ].join(" "),
      `Profiles:\n${profileCatalog}`,
    ].join("\n"),
    executionMode: "sequential",
    inputSchema: z
      .object({
        profile: profileSchema.describe(
          "Target model profile. Prefer the profile whose description best matches the task.",
        ),
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
