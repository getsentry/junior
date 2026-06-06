import { tool } from "@/chat/tools/definition";
import { Type } from "@sinclair/typebox";

/** Create the sandbox shell tool definition exposed to the agent. */
export function createBashTool() {
  return tool({
    description:
      "Run a bash command inside the isolated sandbox workspace. Use this for repository inspection/execution tasks that need shell access. Do not use for network-sensitive or destructive actions unless explicitly required.",
    inputSchema: Type.Object(
      {
        command: Type.String({
          minLength: 1,
          description: "Bash command to run inside the sandbox.",
        }),
        timeoutMs: Type.Optional(
          Type.Integer({
            minimum: 1000,
            description:
              "Optional command timeout in milliseconds. Use for commands that may hang.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async () => {
      throw new Error("bash can only run when sandbox execution is enabled.");
    },
  });
}
