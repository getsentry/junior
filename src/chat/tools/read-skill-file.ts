import { tool } from "ai";
import { z } from "zod";
import { getSkillSandbox, toSkillSandboxToolError } from "@/chat/skill-sandbox";

export function createReadSkillFileTool() {
  return tool({
    description:
      "Read a text file from a loaded skill directory. Use this for progressive disclosure of references from SKILL.md.",
    inputSchema: z.object({
      skill_name: z
        .string()
        .min(1)
        .optional()
        .describe("Optional skill name. If omitted, uses the active loaded skill."),
      file_path: z
        .string()
        .min(1)
        .describe("Relative file path inside the skill directory."),
      max_chars: z
        .number()
        .int()
        .min(1)
        .max(100000)
        .optional()
        .describe("Optional max characters to return from the file content.")
    }),
    execute: async ({ skill_name, file_path, max_chars }, options) => {
      const sandboxResult = getSkillSandbox(options.experimental_context);
      if (!sandboxResult.ok) {
        return { ok: false, error: sandboxResult.error };
      }

      try {
        const file = await sandboxResult.sandbox.readFile({
          skillName: skill_name,
          filePath: file_path,
          maxChars: max_chars
        });

        return {
          ok: true,
          skill_name: file.skillName,
          file_path: file.path,
          truncated: file.truncated,
          content: file.content
        };
      } catch (error) {
        return toSkillSandboxToolError(error);
      }
    }
  });
}
