import fs from "node:fs/promises";
import path from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { createBashTool } from "bash-tool";
import { extractHttpErrorDetails } from "@/chat/http-error-details";
import { setSpanAttributes, setSpanStatus, withSpan, type ObservabilityContext } from "@/chat/observability";
import type { SkillMetadata } from "@/chat/skills";

interface SandboxExecutionInput {
  toolName: string;
  input: unknown;
}

export interface SandboxExecutionEnvelope<T = unknown> {
  result: T;
}

function toPosixRelative(base: string, absolute: string): string {
  return path.relative(base, absolute).split(path.sep).join("/");
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const queue: string[] = [root];
  const files: string[] = [];

  while (queue.length > 0) {
    const dir = queue.shift() as string;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }

  return files;
}

export class VercelSandboxToolExecutor {
  private sandbox: Sandbox | null = null;
  private sandboxIdHint?: string;
  private readonly timeoutMs: number;
  private readonly traceContext: ObservabilityContext;
  private availableSkills: SkillMetadata[] = [];
  private bashToolExecute?:
    | ((input: { command: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>)
    | undefined;

  constructor(options?: {
    sandboxId?: string;
    timeoutMs?: number;
    traceContext?: ObservabilityContext;
  }) {
    this.sandboxIdHint = options?.sandboxId;
    this.timeoutMs = options?.timeoutMs ?? 1000 * 60 * 30;
    this.traceContext = options?.traceContext ?? {};
  }

  configureSkills(skills: SkillMetadata[]): void {
    this.availableSkills = [...skills];
  }

  getSandboxId(): string | undefined {
    return this.sandbox?.sandboxId ?? this.sandboxIdHint;
  }

  canExecute(toolName: string): boolean {
    return toolName === "bash";
  }

  private withSandboxSpan<T>(
    name: string,
    op: string,
    attributes: Record<string, unknown>,
    callback: () => Promise<T>
  ): Promise<T> {
    return withSpan(name, op, this.traceContext, callback, attributes);
  }

  private async upsertSkillsToSandbox(sandbox: Sandbox): Promise<void> {
    await this.withSandboxSpan(
      "sandbox.sync_skills",
      "sandbox.sync",
      {
        "app.sandbox.skills_count": this.availableSkills.length
      },
      async () => {
        const filesToWrite: Array<{ path: string; content: Buffer }> = [];
        const index = {
          skills: [] as Array<{
            name: string;
            description: string;
            root: string;
          }>
        };

        for (const skill of this.availableSkills) {
          const skillFiles = await listFilesRecursive(skill.skillPath);
          for (const absoluteFile of skillFiles) {
            const relative = toPosixRelative(skill.skillPath, absoluteFile);
            if (!relative || relative.startsWith("..")) {
              continue;
            }
            filesToWrite.push({
              path: `/workspace/skills/${skill.name}/${relative}`,
              content: await fs.readFile(absoluteFile)
            });
          }

          index.skills.push({
            name: skill.name,
            description: skill.description,
            root: `/workspace/skills/${skill.name}`
          });
        }

        filesToWrite.push({
          path: "/workspace/skills/index.json",
          content: Buffer.from(JSON.stringify(index), "utf8")
        });

        const bytesWritten = filesToWrite.reduce((total, file) => total + file.content.length, 0);
        const directoriesToEnsure = new Set<string>();
        for (const file of filesToWrite) {
          const normalizedPath = path.posix.normalize(file.path);
          const parts = normalizedPath.split("/").filter(Boolean);
          let current = "";
          for (let index = 0; index < parts.length - 1; index += 1) {
            current = `${current}/${parts[index]}`;
            directoriesToEnsure.add(current);
          }
        }

        await this.withSandboxSpan(
          "sandbox.sync_write_files",
          "sandbox.sync.write",
          {
            "app.sandbox.sync.files_written": filesToWrite.length,
            "app.sandbox.sync.bytes_written": bytesWritten,
            "app.sandbox.sync.directories_ensured": directoriesToEnsure.size
          },
          async () => {
            try {
              for (const directory of Array.from(directoriesToEnsure).sort((a, b) => a.length - b.length)) {
                try {
                  await sandbox.mkDir(directory);
                } catch (error) {
                  const details = extractHttpErrorDetails(error, {
                    attributePrefix: "app.sandbox.api_error",
                    extraFields: [
                      { sourceKey: "sandboxId", attributeKey: "sandbox_id", summaryKey: "sandboxId" }
                    ]
                  });
                  if (
                    details.searchableText.includes("already exists") ||
                    details.searchableText.includes("eexist")
                  ) {
                    continue;
                  }
                  throw error;
                }
              }

              await sandbox.writeFiles(filesToWrite);
            } catch (error) {
              const details = extractHttpErrorDetails(error, {
                attributePrefix: "app.sandbox.api_error",
                extraFields: [{ sourceKey: "sandboxId", attributeKey: "sandbox_id", summaryKey: "sandboxId" }]
              });
              setSpanAttributes({
                ...details.attributes,
                "app.sandbox.api_error.missing_path":
                  details.searchableText.includes("no such file") || details.searchableText.includes("enoent"),
                "app.sandbox.success": false
              });
              setSpanStatus("error");
              throw new Error(
                details.summary
                  ? `sandbox writeFiles failed (${details.summary})`
                  : "sandbox writeFiles failed",
                { cause: error }
              );
            }
          }
        );
      }
    );
  }

  async createSandbox(): Promise<Sandbox> {
    // Intentional: sandbox is a hard requirement for this runtime path.
    // We currently upsert skills on each acquisition to guarantee latest skill content.
    // TODO: optimize by detecting unchanged skill trees (e.g. content hash) and skip writes.
    return this.withSandboxSpan(
      "sandbox.acquire",
      "sandbox.acquire",
      {
        "app.sandbox.id_hint_present": Boolean(this.sandboxIdHint),
        "app.sandbox.timeout_ms": this.timeoutMs,
        "app.sandbox.runtime": "node22",
        "app.sandbox.skills_count": this.availableSkills.length
      },
      async () => {
        if (this.sandbox) {
          await this.withSandboxSpan(
            "sandbox.reuse_cached",
            "sandbox.acquire.cached",
            {
              "app.sandbox.reused": true,
              "app.sandbox.source": "memory"
            },
            async () => {
              await this.upsertSkillsToSandbox(this.sandbox as Sandbox);
            }
          );
          return this.sandbox;
        }

        let sandbox: Sandbox | null = null;
        if (this.sandboxIdHint) {
          try {
            sandbox = await this.withSandboxSpan(
              "sandbox.get",
              "sandbox.get",
              {
                "app.sandbox.reused": true,
                "app.sandbox.source": "id_hint"
              },
              async () => Sandbox.get({ sandboxId: this.sandboxIdHint as string })
            );
          } catch {
            sandbox = null;
          }
        }

        if (!sandbox) {
          try {
            sandbox = await this.withSandboxSpan(
              "sandbox.create",
              "sandbox.create",
              {
                "app.sandbox.reused": false,
                "app.sandbox.source": "created",
                "app.sandbox.timeout_ms": this.timeoutMs,
                "app.sandbox.runtime": "node22"
              },
              async () =>
                Sandbox.create({
                  timeout: this.timeoutMs,
                  runtime: "node22"
                })
            );
          } catch (error) {
            throw new Error("sandbox creation failed", { cause: error });
          }
        }

        try {
          await this.upsertSkillsToSandbox(sandbox);
        } catch (error) {
          throw new Error("sandbox skill sync failed", { cause: error });
        }
        this.sandbox = sandbox;
        this.sandboxIdHint = sandbox.sandboxId;
        return this.sandbox;
      }
    );
  }

  private async getBashToolExecute(): Promise<
    (input: { command: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  > {
    if (this.bashToolExecute) {
      return this.bashToolExecute;
    }

    const sandbox = await this.createSandbox();
    const toolkit = await this.withSandboxSpan(
      "sandbox.bash_tool.init",
      "sandbox.tool.init",
      {
        "app.sandbox.tool_name": "bash",
        "app.sandbox.destination": "/workspace"
      },
      async () =>
        createBashTool({
          sandbox,
          destination: "/workspace"
        })
    );
    const execute = toolkit.tools.bash.execute;
    if (!execute) {
      throw new Error("bash-tool did not return an executable bash tool");
    }

    this.bashToolExecute = async (input: { command: string }) =>
      (await execute(input, {
        toolCallId: "sandbox-bash",
        messages: []
      })) as { stdout: string; stderr: string; exitCode: number };

    return this.bashToolExecute;
  }

  async execute<T>(params: SandboxExecutionInput): Promise<SandboxExecutionEnvelope<T>> {
    const sandbox = await this.createSandbox();
    const keepAliveMs = Number.parseInt(process.env.VERCEL_SANDBOX_KEEPALIVE_MS ?? "0", 10);
    if (Number.isFinite(keepAliveMs) && keepAliveMs > 0) {
      try {
        await this.withSandboxSpan(
          "sandbox.keepalive.extend",
          "sandbox.keepalive",
          {
            "app.sandbox.keepalive_ms": keepAliveMs
          },
          async () => {
            await sandbox.extendTimeout(keepAliveMs);
          }
        );
      } catch {
        // Best effort keepalive.
      }
    }

    if (params.toolName !== "bash") {
      throw new Error(`unsupported sandbox tool: ${params.toolName}`);
    }

    const rawInput = (params.input ?? {}) as Record<string, unknown>;
    const command = String(rawInput.command ?? "").trim();
    if (!command) {
      throw new Error("command is required");
    }

    const executeBash = await this.getBashToolExecute();
    const result = await this.withSandboxSpan(
      "bash",
      "process.exec",
      {
        "process.executable.name": "bash"
      },
      async () => {
        try {
          const response = await executeBash({ command });
          setSpanAttributes({
            "process.exit.code": response.exitCode,
            "app.sandbox.stdout_bytes": Buffer.byteLength(response.stdout ?? "", "utf8"),
            "app.sandbox.stderr_bytes": Buffer.byteLength(response.stderr ?? "", "utf8"),
            ...(response.exitCode !== 0 ? { "error.type": "nonzero_exit" } : {})
          });
          setSpanStatus(response.exitCode === 0 ? "ok" : "error");
          return response;
        } catch (error) {
          setSpanAttributes({
            "error.type": error instanceof Error ? error.name : "sandbox_execute_error"
          });
          setSpanStatus("error");
          throw error;
        }
      }
    );
    return {
      result: {
        ok: result.exitCode === 0,
        command,
        cwd: "/workspace",
        exit_code: result.exitCode,
        signal: null,
        timed_out: false,
        stdout: result.stdout,
        stderr: result.stderr,
        stdout_truncated: false,
        stderr_truncated: false
      } as T
    };
  }

  async dispose(): Promise<void> {
    if (!this.sandbox) return;
    await this.withSandboxSpan(
      "sandbox.stop",
      "sandbox.stop",
      {
        "app.sandbox.stop.blocking": true
      },
      async () => {
        await (this.sandbox as Sandbox).stop({ blocking: true });
      }
    );
    this.sandbox = null;
    this.bashToolExecute = undefined;
  }
}
