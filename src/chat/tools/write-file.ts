import { Type } from "@sinclair/typebox";
import { tool } from "@/chat/tools/definition";

export function createWriteFileTool() {
  return tool({
    description:
      "Write content to a file in the sandbox.",
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
