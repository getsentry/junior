import { z } from "zod";
import {
  formatModelProfile,
  type ModelProfile,
  modelProfileSchema,
} from "@/chat/model-profile";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

export const HANDOFF_TOOL_NAME = "handoff";

function formatHandoffProfiles(
  handoff: NonNullable<ToolRuntimeContext["handoff"]>,
): string {
  return handoff.profiles
    .map(
      (profile) => `- ${formatModelProfile(profile.name, profile.description)}`,
    )
    .join("\n");
}

/** Create the tool that switches the active model profile. */
export function createHandoffTool(
  handoff: NonNullable<ToolRuntimeContext["handoff"]>,
) {
  const profileSchema = z.enum(
    handoff.profiles.map((profile) => profile.name) as [
      ModelProfile,
      ...ModelProfile[],
    ],
  );
  const handoffResultSchema = juniorToolOutputSchema.extend({
    model_profile: modelProfileSchema,
  });
  const profileList = formatHandoffProfiles(handoff);
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description: [
      "Switch this conversation to another configured model profile and continue the same task.",
      "Call this as the only tool in the assistant turn, before substantial analysis or implementation, when a listed profile's description fits the task better than the current profile.",
      "Use each description's use and avoid cases. Do not select by the profile name or assume that a non-default profile is stronger.",
      "Do not call this for ordinary lookups, short answers, light investigation, or only because the task mentions code.",
      "Do not call this after you have done the difficult work on the current profile. Do not combine it with other tools in the same assistant message.",
      "A successful handoff becomes the active profile for later turns. Another handoff can change it again.",
      `Available profiles:\n${profileList}`,
    ].join(" "),
    executionMode: "sequential",
    inputSchema: z
      .object({
        profile: profileSchema.describe(
          "Exact configured profile name. Choose the profile whose description best fits the remaining task. If none clearly fits better, do not call handoff.",
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
