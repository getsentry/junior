import { z } from "zod";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import type { ToolRuntimeContext } from "@/chat/tools/types";

export const HANDOFF_TOOL_NAME = "handoff";

/** Create the terminal standard-agent control for an in-place model upgrade. */
export function createHandoffTool(
  handoff: NonNullable<ToolRuntimeContext["handoff"]>,
) {
  const profileSchema = z.enum(handoff.profiles);
  const defaultProfile = handoff.profiles[0];
  const handoffResultSchema = juniorToolResultSchema.extend({
    model_profile: profileSchema,
  });
  const profileNames = handoff.profiles
    .map((profile) => `\`${profile}\``)
    .join(", ");
  return zodTool({
    description: `Permanently switch this conversation to a more capable model profile, replace prior context with a continuation summary, and continue the same task with the same workspace and all other normal tools. Available profiles: ${profileNames}. Omit profile to use \`${defaultProfile}\`. Call it as the only tool in the assistant message when the system tool policy requires a model upgrade.`,
    executionMode: "sequential",
    inputSchema: z
      .object({
        profile: profileSchema
          .nullish()
          .describe(
            "Named model profile to use for the rest of the conversation; omit or pass null for the default",
          ),
      })
      .strict(),
    outputSchema: handoffResultSchema,
    execute: async (input, options) => {
      const profile = input.profile ?? defaultProfile;
      await handoff.execute(profile, options.signal);
      return {
        ok: true,
        status: "success" as const,
        model_profile: profile,
      };
    },
  });
}
