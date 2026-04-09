import { tool } from "@/chat/tools/definition";
import { Type } from "@sinclair/typebox";

export function createBashTool() {
  return tool({
    description:
      "Run a bash command inside the isolated sandbox workspace. Use this only for repository/file inspection or execution tasks that genuinely need shell access. Do not use for greetings, simple acknowledgements, or questions answerable from the conversation alone. Do not use for network-sensitive or destructive actions unless explicitly required.",
    inputSchema: Type.Object(
      {
        command: Type.String({
          minLength: 1,
          description: "Bash command to run inside the sandbox.",
        }),
      },
      { additionalProperties: false },
    ),
    execute: async () => {
      throw new Error("bash can only run when sandbox execution is enabled.");
    },
  });
}
