import { Type } from "@sinclair/typebox";
import { tool } from "@/chat/tools/definition";

export function createWriteFileTool() {
  return tool({
    description:
      "Write UTF-8 content to a file in the sandbox workspace. Use for intentional file creation or replacement after validation. Do not use for exploratory analysis-only turns.",
    inputSchema: Type.Object({
      path: Type.String({
        minLength: 1,
        description: "Path to write in the sandbox workspace."
      }),
      content: Type.String({
        description: "UTF-8 file content to write."
      })
    }),
    execute: async () => {
      throw new Error("writeFile can only run when sandbox execution is enabled.");
    }
  });
}
