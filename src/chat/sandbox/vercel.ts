import fs from "node:fs/promises";
import path from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { createBashTool } from "bash-tool";
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
  private availableSkills: SkillMetadata[] = [];
  private bashToolExecute?:
    | ((input: { command: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>)
    | undefined;

  constructor(options?: {
    sandboxId?: string;
    timeoutMs?: number;
  }) {
    this.sandboxIdHint = options?.sandboxId;
    this.timeoutMs = options?.timeoutMs ?? 1000 * 60 * 30;
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

  private async upsertSkillsToSandbox(sandbox: Sandbox): Promise<void> {
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

    await sandbox.writeFiles(filesToWrite);
  }

  async createSandbox(): Promise<Sandbox> {
    if (this.sandbox) {
      await this.upsertSkillsToSandbox(this.sandbox);
      return this.sandbox;
    }

    let sandbox: Sandbox | null = null;
    if (this.sandboxIdHint) {
      try {
        sandbox = await Sandbox.get({ sandboxId: this.sandboxIdHint });
      } catch {
        sandbox = null;
      }
    }

    if (!sandbox) {
      try {
        sandbox = await Sandbox.create({
          timeout: this.timeoutMs,
          runtime: "node22"
        });
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

  private async getBashToolExecute(): Promise<
    (input: { command: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  > {
    if (this.bashToolExecute) {
      return this.bashToolExecute;
    }

    const sandbox = await this.createSandbox();
    const toolkit = await createBashTool({
      sandbox,
      destination: "/workspace"
    });
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
        await sandbox.extendTimeout(keepAliveMs);
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
    const result = await executeBash({ command });
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
    await this.sandbox.stop({ blocking: true });
    this.sandbox = null;
    this.bashToolExecute = undefined;
  }
}
