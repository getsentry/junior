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
      "Permanently switch this conversation to another configured model profile and continue the same task under that profile.",
      "Call this as the only tool in the assistant turn, before substantive analysis or implementation, when a listed profile's description is a clearly better fit than the current profile.",
      "Match on the profile description (use/avoid cues), not the bare profile name or an assumption that non-default means stronger.",
      "Do not call this for ordinary lookups, short answers, light investigation, or merely because the task mentions code.",
      "Do not call this after you have already done the hard work on the current profile, and do not combine it with other tools in the same assistant message.",
      "After a successful handoff, later turns stay on the selected profile; there is no downgrade path from this tool.",
      `Available profiles:\n${profileCatalog}`,
    ].join(" "),
    executionMode: "sequential",
    inputSchema: z
      .object({
        profile: profileSchema.describe(
          "Exact configured profile name to switch to. Choose the profile whose description best matches the outstanding task; if none is clearly better, do not call handoff.",
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
