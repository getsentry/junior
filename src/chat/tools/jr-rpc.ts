import { Type } from "@sinclair/typebox";
import { tool } from "@/chat/tools/definition";

export function createJrRpcTool() {
  return tool({
    description:
      "Issue short-lived capability credentials and optionally execute a nested sandbox command with injected env.",
    inputSchema: Type.Union([
      Type.Object({
        action: Type.Literal("issue"),
        capability: Type.String({ minLength: 1, description: "Capability token, for example github.issues.write." }),
        repo: Type.String({ minLength: 1, description: "Target repository in owner/repo format." }),
        format: Type.Optional(
          Type.Union([Type.Literal("token"), Type.Literal("env"), Type.Literal("json")], {
            description: "Output format for issue mode. Defaults to token."
          })
        )
      }),
      Type.Object({
        action: Type.Literal("exec"),
        capability: Type.String({ minLength: 1, description: "Capability token, for example github.issues.write." }),
        repo: Type.String({ minLength: 1, description: "Target repository in owner/repo format." }),
        command: Type.String({ minLength: 1, description: "Nested command executed with scoped credential env." })
      })
    ]),
    execute: async () => {
      throw new Error("jrRpc can only run when capability runtime execution is enabled.");
    }
  });
}
