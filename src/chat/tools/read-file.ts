import { Type } from "@sinclair/typebox";
import { tool } from "@/chat/tools/definition";

export function createReadFileTool() {
  return tool({
    description:
      "Read the contents of a file from the sandbox.",
    inputSchema: Type.Object({
      path: Type.String({
        minLength: 1,
        description: "Path to the file in the sandbox workspace."
      })
    }),
    execute: async () => {
      throw new Error("readFile can only run when sandbox execution is enabled.");
    }
  });
}
