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
      .regex(/^(?:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)$/)
      .refine(
        (value) =>
          !value.split("/").some((part) => part === "." || part === ".."),
        {
          message:
            "Directory must be a relative path without . or .. segments.",
        },
      )
      .describe(
        "Optional destination directory under the sandbox root. Defaults to repos/{name}.",
      )
      .optional(),
    allowAdHoc: z
      .boolean()
      .optional()
      .describe(
        "Set true to keep an intentional ad-hoc checkout when matching Workspaces exist. Prefer switchWorkspace; the checkout is already present after a successful switch.",
      ),
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
const outputSchema = pluginToolOutputSchema.merge(
  cloneSchema.extend({
    target: z.literal("cloneRepository"),
  }),
);

function parseRepo(value: string): { name: string; owner: string } {
  const parts = value.split("/").map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new PluginToolInputError('repo must use "owner/name" format');
  }
  return { owner: parts[0], name: parts[1] };
}

/** Agent-facing input rejection when a matching Workspace should be used instead. */
function workspaceRequiredError(
  repoId: string,
  workspaces: string[],
): PluginToolInputError {
  const names = workspaces.map((name) => `"${name}"`).join(", ");
  if (workspaces.length === 1) {
    return new PluginToolInputError(
      `Repository ${repoId} is part of Workspace ${names}. Call switchWorkspace with that name; the checkout is already present after the switch. Pass allowAdHoc=true only for an intentional ad-hoc checkout.`,
    );
  }
  return new PluginToolInputError(
    `Repository ${repoId} is part of Workspaces ${names}. Call switchWorkspace with one of those names; the checkout is already present after the switch. Pass allowAdHoc=true only for an intentional ad-hoc checkout.`,
  );
}

function defaultDirectory(repoName: string): string {
  // Keep ad-hoc clones under repos/ so they match Workspace layout and stay
  // clear of reserved sandbox roots (skills, data, .junior).
  return `repos/${repoName}`;
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

/** Clone one GitHub repository into the sandbox as an ad-hoc checkout. */
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
      "Clone a GitHub repository into the sandbox as an ad-hoc checkout. The destination must not already exist. When matching Workspaces exist this is a tool input error: call switchWorkspace instead, or pass allowAdHoc=true for an intentional ad-hoc checkout.",
    describeProposal(input) {
      const directory =
        typeof input.directory === "string" && input.directory.length > 0
          ? input.directory
          : undefined;
      const adHoc =
        input.allowAdHoc === true ? " as an intentional ad-hoc checkout" : "";
      return directory
        ? `Shallow-clone ${input.repo} into the local sandbox at ${directory}${adHoc} for inspection (no GitHub mutation).`
        : `Shallow-clone ${input.repo} into the local sandbox${adHoc} for inspection (no GitHub mutation).`;
    },
    executionMode: "sequential",
    inputSchema,
    outputSchema,
    async execute(input, options): Promise<Result> {
      const repo = parseRepo(input.repo);
      const repoId = `${repo.owner}/${repo.name}`;
      // Look up matching recipes before any sandbox write so a later
      // switchWorkspace does not discard a just-created ad-hoc clone.
      let workspaces: string[] = [];
      try {
        workspaces = await ctx.workspaces.findByRepository({
          provider: "github",
          repo: repoId,
        });
      } catch (error) {
        // Fail open: a lookup outage must not block inspection clones.
        ctx.log.error("github.clone.workspaces_lookup.failed", {
          repo: repoId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (workspaces.length > 0 && input.allowAdHoc !== true) {
        throw workspaceRequiredError(repoId, workspaces);
      }
      const directory = input.directory ?? defaultDirectory(repo.name);
      const rootSegment = directory.split("/")[0] ?? directory;
      if (isReservedSandboxDirectory(rootSegment)) {
        throw new PluginToolInputError(
          `Directory conflicts with a reserved sandbox path: ${directory}`,
        );
      }
      const path = `${ctx.sandbox.root}/${directory}`;
      const parentDirectory = directory.includes("/")
        ? directory.slice(0, directory.lastIndexOf("/"))
        : undefined;
      if (parentDirectory) {
        const mkdir = await ctx.sandbox.run({
          cmd: "mkdir",
          args: ["-p", "--", `${ctx.sandbox.root}/${parentDirectory}`],
          cwd: ctx.sandbox.root,
          signal: commandSignal(options.signal, 30_000),
        });
        if (mkdir.exitCode !== 0) {
          throw new PluginToolInputError(
            `Failed to create clone parent directory: ${parentDirectory}`,
          );
        }
      }
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
      return { target: "cloneRepository", repo: repoId, path };
    },
  });
}
