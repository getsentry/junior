import * as z from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";

const DESCRIPTIONS = {
  parent: {
    tool: "End this delegated task as blocked. Call this when missing access, credentials, input, or a decision stops the task, also when a search for the missing part found nothing. Do not guess, mock, or fake results to work around it.",
    missing:
      "What the task needs and who can give it. Add the work you already did, so the parent does not repeat it.",
  },
  automation: {
    tool: "End this Turn and block the Automation until someone fixes it. Call this when a provider, tool, account, or access that the job needs is missing, a target no longer exists, or the instruction cannot be done. Do not call it for a temporary failure or a condition that is not met.",
    missing:
      "What the Automation needs and who can give it. One sentence for the creator.",
  },
} as const;

/** Static definition of `reportBlocked` for one report target. */
export function reportBlockedToolDefinition(target: "parent" | "automation") {
  const descriptions = DESCRIPTIONS[target];
  return zodToolDefinition({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description: descriptions.tool,
    exposure: "modelOnly",
    inputSchema: z
      .object({
        missing: z.string().trim().min(1).describe(descriptions.missing),
      })
      .strict(),
    outputSchema: juniorToolOutputSchema.extend({ missing: z.string() }),
  });
}

/**
 * Create the tool that ends a Turn as blocked. `parent`: a child agent reports
 * to its parent. `automation`: the Automation is blocked.
 */
export function createReportBlockedTool(target: "parent" | "automation") {
  return zodTool({
    ...reportBlockedToolDefinition(target),
    execute: async (input) => ({ missing: input.missing }),
  });
}
