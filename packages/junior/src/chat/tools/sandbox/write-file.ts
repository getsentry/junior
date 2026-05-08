import { Type } from "@sinclair/typebox";
import { tool } from "@/chat/tools/definition";

/** Create the sandbox full-file write tool definition exposed to the agent. */
export function createWriteFileTool() {
  return tool({
    description:
      "Write UTF-8 content to a file in the sandbox workspace. Use for intentional file creation or replacement after validation. Do not use for exploratory analysis-only turns.",
    promptSnippet: "new file or deliberate full-file replacement",
    promptGuidelines: ["targeted existing-file changes: editFile"],
    executionMode: "sequential",
    inputSchema: Type.Object(
      {
        path: Type.String({
          minLength: 1,
          description: "Path to write in the sandbox workspace.",
        }),
        content: Type.String({
          description: "UTF-8 file content to write.",
        }),
      },
      { additionalProperties: false },
    ),
    execute: async () => {
      throw new Error(
        "writeFile can only run when sandbox execution is enabled.",
      );
    },
  });
}
