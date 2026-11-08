import * as z from "zod";
import {
  USER_CUSTOMIZATION_MAX_CHARS,
  userCustomizationTextSchema,
} from "@/api/schema/user-customization";
import { isExperimentalFeatureEnabled } from "@/chat/experimental";
import { saveUserCustomization } from "@/chat/identities/customization";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRegistry } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const USER_CUSTOMIZATION_TOOL_SOURCE = {
  id: "user-customization",
  description: "Save how replies change for the current user.",
} as const;

/**
 * Build the tool that saves the current user's customization when the app
 * enables `user-customization`. An Agent invocation never gets it, because
 * an agent wrote its input.
 */
export function createUserCustomizationTools(
  context: ToolRuntimeContext,
): ToolRegistry {
  if (!isExperimentalFeatureEnabled("user-customization")) return {};
  if (context.agentInvocationId) return {};

  return {
    updateUserCustomization: zodTool({
      exposure: "deferred",
      source: USER_CUSTOMIZATION_TOOL_SOURCE,
      executionMode: "sequential",
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description: `Replace the current user's saved customization: short text that changes how you reply to them in every conversation, such as "keep replies short". Use it only when the user's latest message asks to change it. Pass the complete new text, including any saved text from \`<user-customization>\` to keep. Pass an empty string to clear it. Maximum ${USER_CUSTOMIZATION_MAX_CHARS} characters.`,
      inputSchema: z
        .object({
          customization: userCustomizationTextSchema.describe(
            "The complete new customization text.",
          ),
        })
        .strict(),
      outputSchema: juniorToolOutputSchema.extend({
        customization: z.string(),
      }),
      async execute(input) {
        const user = (await context.resolveActorIdentity?.())?.user;
        if (!user) {
          throw new ToolInputError(
            "This person has no linked Junior user, so customization cannot be saved.",
          );
        }
        if (!(await saveUserCustomization(user.id, input.customization))) {
          throw new Error("User customization target user was not found.");
        }
        return { customization: input.customization };
      },
    }),
  };
}
