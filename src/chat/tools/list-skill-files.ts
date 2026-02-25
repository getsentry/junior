import { tool } from "ai";
import { z } from "zod";
import { getSkillSandbox, toSkillSandboxToolError } from "@/chat/skill-sandbox";

export function createListSkillFilesTool() {
  return tool({
    description:
      "List files from a loaded skill directory. Use this to discover references linked from SKILL.md instructions.",
    inputSchema: z.object({
      skill_name: z
        .string()
        .min(1)
        .optional()
        .describe("Optional skill name. If omitted, uses the active loaded skill."),
      directory: z
        .string()
        .min(1)
        .default(".")
        .describe("Relative directory path inside the skill."),
      recursive: z
        .boolean()
        .optional()
        .describe("Recursively traverse nested directories when true."),
      max_entries: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Maximum entries to return, up to 1000.")
    }),
    execute: async ({ skill_name, directory, recursive, max_entries }, options) => {
      const sandboxResult = getSkillSandbox(options.experimental_context);
      if (!sandboxResult.ok) {
        return { ok: false, error: sandboxResult.error };
      }

      try {
        const listed = await sandboxResult.sandbox.listFiles({
          skillName: skill_name,
          directory,
          recursive,
          maxEntries: max_entries
        });

        return {
          ok: true,
          skill_name: listed.skillName,
          directory: listed.directory,
          truncated: listed.truncated,
          entries: listed.entries
        };
      } catch (error) {
        return toSkillSandboxToolError(error);
      }
    }
  });
}
