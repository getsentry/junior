import { tool } from "@/chat/tools/definition";
import { Type } from "@sinclair/typebox";

export function createBashTool() {
  return tool({
    description:
      "Run a bash command inside the isolated sandbox workspace. Use this to inspect skill files and execute repository-safe shell tasks.",
    inputSchema: Type.Object({
      command: Type.String({
        minLength: 1,
        description: "Bash command to run inside the sandbox."
      })
    }),
    execute: async () => {
      throw new Error("bash can only run when sandbox execution is enabled.");
    }
  });
}
