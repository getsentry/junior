import {
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
  type PluginToolOutput,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { isReservedSandboxDirectory } from "../sandbox-paths.js";

const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    directory: z
      .string()
      .regex(/^[A-Za-z0-9._-]+$/)
      .refine((value) => value !== "." && value !== "..", {
        message: "Directory must be a single directory name.",
      })
      .describe("Optional destination directory under the sandbox root.")
      .optional(),
  })
  .strict();
const cloneSchema = z.object({
  path: z.string(),
  repo: z.string(),
});
type Clone = z.output<typeof cloneSchema>;
interface Result extends PluginToolOutput, Clone {
  target: "cloneRepository";
}
const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("cloneRepository"),
  ...cloneSchema.shape,
});

function parseRepo(value: string): { name: string; owner: string } {
  const parts = value.split("/").map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new PluginToolInputError('repo must use "owner/name" format');
  }
  return { owner: parts[0], name: parts[1] };
}

function defaultDirectory(repoName: string): string {
  return isReservedSandboxDirectory(repoName)
    ? `${repoName}-repo`
    : repoName;
}

function commandSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function removePartialClone(
  ctx: ToolRegistrationHookContext,
  path: string,
): Promise<void> {
  try {
    const result = await ctx.sandbox.run({
      cmd: "rm",
      args: ["-rf", "--", path],
      cwd: ctx.sandbox.root,
      signal: AbortSignal.timeout(30_000),
    });
    if (result.exitCode !== 0) {
      ctx.log.warn("github.clone.cleanup.failed", {
        path,
        stderr: result.stderr,
      });
    }
  } catch (error) {
    ctx.log.warn("github.clone.cleanup.failed", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Clone one GitHub repository into the sandbox workspace. */
export function createGitHubCloneRepositoryTool(
  ctx: ToolRegistrationHookContext,
) {
  return definePluginTool({
    annotations: {
      // Remote GitHub effect is contents-read only. Sandbox checkout creation is
      // the same class of ephemeral local materialization as webFetch artifacts,
      // so this stays a read-only inspection tool rather than a mutating write.
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description:
      "Clone a GitHub repository into the sandbox workspace. The destination must not already exist.",
    describeProposal(input) {
      const directory =
        typeof input.directory === "string" && input.directory.length > 0
          ? input.directory
          : undefined;
      return directory
        ? `Shallow-clone ${input.repo} into the local sandbox at ${directory} for inspection (no GitHub mutation).`
        : `Shallow-clone ${input.repo} into the local sandbox for inspection (no GitHub mutation).`;
    },
    executionMode: "sequential",
    inputSchema,
    outputSchema,
    async execute(input, options): Promise<Result> {
      const repo = parseRepo(input.repo);
      const directory = input.directory ?? defaultDirectory(repo.name);
      const path = `${ctx.sandbox.root}/${directory}`;
      const exists = await ctx.sandbox.run({
        cmd: "bash",
        args: ["-c", `test -e "$1"`, "bash", path],
        cwd: ctx.sandbox.root,
        signal: commandSignal(options.signal, 30_000),
      });
      if (exists.exitCode === 0) {
        throw new PluginToolInputError(`destination already exists: ${path}`);
      }
      // Git smart HTTP uses git-upload-pack for clone, fetch, pull, deepen, and
      // ls-remote, so egress policy cannot distinguish clone without also
      // blocking normal repository workflows. This tool is the bounded,
      // preferred clone path rather than an enforceable network boundary.
      let clone;
      try {
        clone = await ctx.sandbox.run({
          cmd: "git",
          args: [
            "clone",
            "--quiet",
            "--depth=1",
            "--",
            `https://github.com/${repo.owner}/${repo.name}.git`,
            directory,
          ],
          cwd: ctx.sandbox.root,
          signal: commandSignal(options.signal, 2 * 60_000),
        });
      } catch (error) {
        await removePartialClone(ctx, path);
        throw error;
      }
      if (clone.exitCode !== 0) {
        await removePartialClone(ctx, path);
        throw new PluginToolInputError(
          `GitHub repository clone failed: ${clone.stderr.trim() || `exit ${clone.exitCode}`}`,
        );
      }
      const data = { repo: `${repo.owner}/${repo.name}`, path };
      return { target: "cloneRepository", ...data };
    },
  });
}
