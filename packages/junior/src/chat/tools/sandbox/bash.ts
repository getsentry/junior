import * as z from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";

export const bashToolDefinition = zodToolDefinition({
  annotations: {
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
    readOnlyHint: false,
  },
  description:
    "Run a bash command inside the isolated sandbox workspace. Use this for repository inspection/execution tasks that need shell access. Do not use for network-sensitive or destructive actions unless explicitly required.",
  inputSchema: z.object({
    command: z
      .string()
      .min(1)
      .describe("Bash command to run inside the sandbox."),
    cwd: z
      .string()
      .min(1)
      .describe("Optional working directory for this command only.")
      .optional(),
    timeout_ms: z.coerce
      .number()
      .int()
      .min(1000)
      .describe(
        "Optional command timeout in milliseconds. Use for commands that may hang.",
      )
      .optional(),
  }),
  outputSchema: juniorToolOutputSchema,
  // Egress auth signals are per egress session. The sandbox runs one bash
  // command at a time so each command reads only its own signals.
  executionMode: "sequential",
});

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Progress text is visible to everyone in the conversation, so only these
// well-known program names are shown. Any other word may be a script name,
// a quoted value, or a secret.
const KNOWN_PROGRAMS = new Set([
  "awk",
  "cargo",
  "cat",
  "curl",
  "docker",
  "find",
  "gh",
  "git",
  "go",
  "grep",
  "head",
  "jq",
  "ls",
  "make",
  "node",
  "npm",
  "npx",
  "pip",
  "pnpm",
  "pytest",
  "python",
  "python3",
  "rg",
  "sed",
  "tail",
  "tsc",
  "uv",
  "vitest",
  "wc",
  "yarn",
]);

/**
 * Name the first program a command runs, for progress text. Skips `cd` and
 * leading env assignments, returns only well-known program names, and never
 * returns arguments, which may hold secrets.
 */
export function commandProgramName(command: string): string | undefined {
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().split(/\s+/);
    while (words[0] && ENV_ASSIGNMENT.test(words[0])) {
      // A quoted value can hold spaces, so the next word is not the program.
      if (/["'\\]/.test(words[0])) {
        return undefined;
      }
      words.shift();
    }
    const program = words[0]?.split("/").pop();
    if (!program || program === "cd") {
      continue;
    }
    return KNOWN_PROGRAMS.has(program) ? program : undefined;
  }
  return undefined;
}

/** Create the sandbox shell tool definition exposed to the agent. */
export function createBashTool() {
  return zodTool({
    ...bashToolDefinition,
    describeProgress: ({ command }) => {
      const program = commandProgramName(command);
      return program ? `Running ${program}` : "Running commands";
    },
    execute: async () => {
      throw new Error("bash can only run when sandbox execution is enabled.");
    },
  });
}
