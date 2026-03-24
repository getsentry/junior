import { Type } from "@sinclair/typebox";
import { tool } from "@/chat/tools/definition";

export function createReadFileTool() {
  return tool({
    description:
      "Read a file from the sandbox workspace. Use when you need exact file contents to verify facts or make edits safely. Do not use for broad discovery when search tools are better.",
    inputSchema: Type.Object(
      {
        path: Type.String({
          minLength: 1,
          description: "Path to the file in the sandbox workspace.",
        }),
      },
      { additionalProperties: false },
    ),
    execute: async () => {
      throw new Error(
        "readFile can only run when sandbox execution is enabled.",
      );
    },
  });
}
