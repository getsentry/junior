import fs from "node:fs/promises";
import path from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { createBashTool } from "bash-tool";
import { extractHttpErrorDetails } from "@/chat/http-error-details";
import { setSpanAttributes, setSpanStatus, withSpan, type ObservabilityContext } from "@/chat/observability";
import { SANDBOX_SKILLS_ROOT, SANDBOX_WORKSPACE_ROOT, sandboxSkillDir } from "@/chat/sandbox/paths";
import type { SkillMetadata } from "@/chat/skills";

interface SandboxExecutionInput {
  toolName: string;
  input: unknown;
}

export interface SandboxExecutionEnvelope<T = unknown> {
  result: T;
}

export interface SandboxExecutor {
  configureSkills(skills: SkillMetadata[]): void;
  getSandboxId(): string | undefined;
  canExecute(toolName: string): boolean;
  createSandbox(): Promise<Sandbox>;
  execute<T>(params: SandboxExecutionInput): Promise<SandboxExecutionEnvelope<T>>;
  dispose(): Promise<void>;
}

interface ToolExecutors {
  bash: (input: { command: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readFile: (input: { path: string }) => Promise<{ content: string }>;
  writeFile: (input: { path: string; content: string }) => Promise<{ success: boolean }>;
}

const SANDBOX_TOOL_NAMES = new Set(["bash", "readFile", "writeFile"]);
const SANDBOX_ERROR_FIELDS = [{ sourceKey: "sandboxId", attributeKey: "sandbox_id", summaryKey: "sandboxId" }] as const;

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

async function buildSkillSyncFiles(availableSkills: SkillMetadata[]): Promise<Array<{ path: string; content: Buffer }>> {
  const filesToWrite: Array<{ path: string; content: Buffer }> = [];
  const index = {
    skills: [] as Array<{
      name: string;
      description: string;
      root: string;
    }>
  };

  for (const skill of availableSkills) {
    const skillFiles = await listFilesRecursive(skill.skillPath);
    for (const absoluteFile of skillFiles) {
      const relative = toPosixRelative(skill.skillPath, absoluteFile);
      if (!relative || relative.startsWith("..")) {
        continue;
      }
      filesToWrite.push({
        path: `${sandboxSkillDir(skill.name)}/${relative}`,
        content: await fs.readFile(absoluteFile)
      });
    }

    index.skills.push({
      name: skill.name,
      description: skill.description,
      root: sandboxSkillDir(skill.name)
    });
  }

  filesToWrite.push({
    path: `${SANDBOX_SKILLS_ROOT}/index.json`,
    content: Buffer.from(JSON.stringify(index), "utf8")
  });

  return filesToWrite;
}

function collectDirectories(filesToWrite: Array<{ path: string; content: Buffer }>): string[] {
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

  return Array.from(directoriesToEnsure)
    .filter((directory) => directory === SANDBOX_SKILLS_ROOT || directory.startsWith(`${SANDBOX_SKILLS_ROOT}/`))
    .sort((a, b) => a.length - b.length);
}

function getSandboxErrorDetails(error: unknown) {
  return extractHttpErrorDetails(error, {
    attributePrefix: "app.sandbox.api_error",
    extraFields: [...SANDBOX_ERROR_FIELDS]
  });
}

function isAlreadyExistsError(error: unknown): boolean {
  const details = getSandboxErrorDetails(error);
  return (
    details.searchableText.includes("already exists") ||
    details.searchableText.includes("file exists") ||
    details.searchableText.includes("eexist")
  );
}

function findInErrorChain(error: unknown, predicate: (candidate: unknown) => boolean): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    if (predicate(current)) {
      return true;
    }
    seen.add(current);
    if (typeof current === "object") {
      current = (current as { cause?: unknown }).cause;
    } else {
      current = undefined;
    }
  }
  return false;
}

function isSandboxUnavailableError(error: unknown): boolean {
  return findInErrorChain(error, (candidate) => {
    const details = getSandboxErrorDetails(candidate);
    const searchable = `${details.searchableText} ${details.summary}`.toLowerCase();
    return (
      searchable.includes("sandbox_stopped") ||
      searchable.includes("status=410") ||
      searchable.includes("status code 410") ||
      searchable.includes("no longer available")
    );
  });
}

function wrapSandboxSetupError(error: unknown): Error {
  return new Error("sandbox setup failed", { cause: error });
}

function throwSandboxOperationError(action: string, error: unknown, includeMissingPath = false): never {
  const details = getSandboxErrorDetails(error);
  setSpanAttributes({
    ...details.attributes,
    ...(includeMissingPath
      ? {
          "app.sandbox.api_error.missing_path":
            details.searchableText.includes("no such file") || details.searchableText.includes("enoent")
        }
      : {}),
    "app.sandbox.success": false
  });
  setSpanStatus("error");
  throw new Error(details.summary ? `${action} failed (${details.summary})` : `${action} failed`, {
    cause: error
  });
}

export function createSandboxExecutor(options?: {
  sandboxId?: string;
  timeoutMs?: number;
  traceContext?: ObservabilityContext;
}): SandboxExecutor {
  let sandbox: Sandbox | null = null;
  let sandboxIdHint = options?.sandboxId;
  let availableSkills: SkillMetadata[] = [];
  let toolExecutors: ToolExecutors | undefined;

  const timeoutMs = options?.timeoutMs ?? 1000 * 60 * 30;
  const traceContext = options?.traceContext ?? {};

  const withSandboxSpan = <T>(
    name: string,
    op: string,
    attributes: Record<string, unknown>,
    callback: () => Promise<T>
  ): Promise<T> => withSpan(name, op, traceContext, callback, attributes);

  const upsertSkillsToSandbox = async (targetSandbox: Sandbox): Promise<void> => {
    await withSandboxSpan(
      "sandbox.sync_skills",
      "sandbox.sync",
      {
        "app.sandbox.skills_count": availableSkills.length
      },
      async () => {
        const filesToWrite = await buildSkillSyncFiles(availableSkills);
        const bytesWritten = filesToWrite.reduce((total, file) => total + file.content.length, 0);
        const directories = collectDirectories(filesToWrite);

        await withSandboxSpan(
          "sandbox.sync_writeFiles",
          "sandbox.sync.write",
          {
            "app.sandbox.sync.files_written": filesToWrite.length,
            "app.sandbox.sync.bytes_written": bytesWritten,
            "app.sandbox.sync.directories_ensured": directories.length
          },
          async () => {
            try {
              for (const directory of directories) {
                try {
                  await targetSandbox.mkDir(directory);
                } catch (error) {
                  if (!isAlreadyExistsError(error)) {
                    throw error;
                  }
                }
              }

              await targetSandbox.writeFiles(filesToWrite);
            } catch (error) {
              throwSandboxOperationError("sandbox writeFiles", error, true);
            }
          }
        );
      }
    );
  };

  const createSandbox = async (): Promise<Sandbox> => {
    return withSandboxSpan(
      "sandbox.acquire",
      "sandbox.acquire",
      {
        "app.sandbox.id_hint_present": Boolean(sandboxIdHint),
        "app.sandbox.timeout_ms": timeoutMs,
        "app.sandbox.runtime": "node22",
        "app.sandbox.skills_count": availableSkills.length
      },
      async () => {
        const assignSandbox = (nextSandbox: Sandbox): Sandbox => {
          sandbox = nextSandbox;
          sandboxIdHint = nextSandbox.sandboxId;
          toolExecutors = undefined;
          return nextSandbox;
        };

        const createFreshSandbox = async (): Promise<Sandbox> => {
          let createdSandbox: Sandbox;
          try {
            createdSandbox = await withSandboxSpan(
              "sandbox.create",
              "sandbox.create",
              {
                "app.sandbox.reused": false,
                "app.sandbox.source": "created",
                "app.sandbox.timeout_ms": timeoutMs,
                "app.sandbox.runtime": "node22"
              },
              async () =>
                Sandbox.create({
                  timeout: timeoutMs,
                  runtime: "node22"
                })
            );
          } catch (error) {
            throw wrapSandboxSetupError(error);
          }

          try {
            await upsertSkillsToSandbox(createdSandbox);
          } catch (error) {
            throw wrapSandboxSetupError(error);
          }
          return assignSandbox(createdSandbox);
        };

        const recoverUnavailableSandbox = async (source: "memory" | "id_hint"): Promise<Sandbox> => {
          setSpanAttributes({
            "app.sandbox.recovery.attempted": true,
            "app.sandbox.recovery.source": source
          });
          sandbox = null;
          sandboxIdHint = undefined;
          toolExecutors = undefined;
          const replacement = await createFreshSandbox();
          setSpanAttributes({
            "app.sandbox.recovery.succeeded": true
          });
          return replacement;
        };

        if (sandbox) {
          const cachedSandbox = sandbox;
          try {
            await withSandboxSpan(
              "sandbox.reuse_cached",
              "sandbox.acquire.cached",
              {
                "app.sandbox.reused": true,
                "app.sandbox.source": "memory"
              },
              async () => {
                await upsertSkillsToSandbox(cachedSandbox);
              }
            );
            return cachedSandbox;
          } catch (error) {
            if (isSandboxUnavailableError(error)) {
              return recoverUnavailableSandbox("memory");
            }
            throw wrapSandboxSetupError(error);
          }
        }

        let acquiredSandbox: Sandbox | null = null;
        if (sandboxIdHint) {
          try {
            acquiredSandbox = await withSandboxSpan(
              "sandbox.get",
              "sandbox.get",
              {
                "app.sandbox.reused": true,
                "app.sandbox.source": "id_hint"
              },
              async () => Sandbox.get({ sandboxId: sandboxIdHint as string })
            );
          } catch {
            acquiredSandbox = null;
          }
        }

        if (acquiredSandbox) {
          try {
            await upsertSkillsToSandbox(acquiredSandbox);
            return assignSandbox(acquiredSandbox);
          } catch (error) {
            if (isSandboxUnavailableError(error)) {
              return recoverUnavailableSandbox("id_hint");
            }
            throw wrapSandboxSetupError(error);
          }
        }

        return createFreshSandbox();
      }
    );
  };

  const getToolExecutors = async (): Promise<ToolExecutors> => {
    if (toolExecutors) {
      return toolExecutors;
    }

    const activeSandbox = await createSandbox();
    const toolkit = await withSandboxSpan(
      "sandbox.bash_tool.init",
      "sandbox.tool.init",
      {
        "app.sandbox.tool_name": "bash",
        "app.sandbox.destination": SANDBOX_WORKSPACE_ROOT
      },
      async () =>
        createBashTool({
          sandbox: activeSandbox,
          destination: SANDBOX_WORKSPACE_ROOT
        })
    );

    const executeBash = toolkit.tools.bash.execute;
    const executeReadFile = toolkit.tools.readFile.execute;
    const executeWriteFile = toolkit.tools.writeFile.execute;
    if (!executeBash || !executeReadFile || !executeWriteFile) {
      throw new Error("bash-tool did not return executable tool handlers");
    }

    toolExecutors = {
      bash: async (input) =>
        (await executeBash(input, {
          toolCallId: "sandbox-bash",
          messages: []
        })) as { stdout: string; stderr: string; exitCode: number },
      readFile: async (input) =>
        (await executeReadFile(input, {
          toolCallId: "sandbox-read-file",
          messages: []
        })) as { content: string },
      writeFile: async (input) =>
        (await executeWriteFile(input, {
          toolCallId: "sandbox-write-file",
          messages: []
        })) as { success: boolean }
    };

    return toolExecutors;
  };

  const execute = async <T>(params: SandboxExecutionInput): Promise<SandboxExecutionEnvelope<T>> => {
    const activeSandbox = await createSandbox();
    const keepAliveMs = Number.parseInt(process.env.VERCEL_SANDBOX_KEEPALIVE_MS ?? "0", 10);
    if (Number.isFinite(keepAliveMs) && keepAliveMs > 0) {
      try {
        await withSandboxSpan(
          "sandbox.keepalive.extend",
          "sandbox.keepalive",
          {
            "app.sandbox.keepalive_ms": keepAliveMs
          },
          async () => {
            await activeSandbox.extendTimeout(keepAliveMs);
          }
        );
      } catch {
        // Best effort keepalive.
      }
    }

    const rawInput = (params.input ?? {}) as Record<string, unknown>;

    if (params.toolName === "bash") {
      const command = String(rawInput.command ?? "").trim();
      if (!command) {
        throw new Error("command is required");
      }

      const executeBash = (await getToolExecutors()).bash;
      const result = await withSandboxSpan(
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
          cwd: SANDBOX_WORKSPACE_ROOT,
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

    if (params.toolName === "readFile") {
      const filePath = String(rawInput.path ?? "").trim();
      if (!filePath) {
        throw new Error("path is required");
      }

      const executeReadFile = (await getToolExecutors()).readFile;
      const result = await withSandboxSpan(
        "sandbox.readFile",
        "sandbox.fs.read",
        {
          "app.sandbox.path.length": filePath.length
        },
        async () => {
          const response = await executeReadFile({ path: filePath });
          const content = String(response.content ?? "");
          setSpanAttributes({
            "app.sandbox.read.bytes": Buffer.byteLength(content, "utf8"),
            "app.sandbox.read.chars": content.length
          });
          setSpanStatus("ok");
          return {
            content,
            path: filePath,
            success: true
          };
        }
      );

      return { result: result as T };
    }

    if (params.toolName === "writeFile") {
      const filePath = String(rawInput.path ?? "").trim();
      if (!filePath) {
        throw new Error("path is required");
      }

      const content = String(rawInput.content ?? "");
      const executeWriteFile = (await getToolExecutors()).writeFile;
      await withSandboxSpan(
        "sandbox.writeFile",
        "sandbox.fs.write",
        {
          "app.sandbox.path.length": filePath.length,
          "app.sandbox.write.bytes": Buffer.byteLength(content, "utf8")
        },
        async () => {
          try {
            await executeWriteFile({ path: filePath, content });
            setSpanStatus("ok");
          } catch (error) {
            throwSandboxOperationError("sandbox writeFile", error);
          }
        }
      );

      return {
        result: {
          ok: true,
          path: filePath,
          bytes_written: Buffer.byteLength(content, "utf8")
        } as T
      };
    }

    throw new Error(`unsupported sandbox tool: ${params.toolName}`);
  };

  const dispose = async (): Promise<void> => {
    if (!sandbox) {
      return;
    }

    await withSandboxSpan(
      "sandbox.stop",
      "sandbox.stop",
      {
        "app.sandbox.stop.blocking": true
      },
      async () => {
        await (sandbox as Sandbox).stop({ blocking: true });
      }
    );

    sandbox = null;
    toolExecutors = undefined;
  };

  return {
    configureSkills(skills: SkillMetadata[]) {
      availableSkills = [...skills];
    },
    getSandboxId() {
      return sandbox?.sandboxId ?? sandboxIdHint;
    },
    canExecute(toolName: string) {
      return SANDBOX_TOOL_NAMES.has(toolName);
    },
    createSandbox,
    execute,
    dispose
  };
}
