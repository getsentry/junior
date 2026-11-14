import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";

const run = promisify(execFile);

/** A workspace backed by a local directory, so sandbox commands really run. */
export function localWorkspace(root: string): SandboxWorkspace & {
  commands: string[];
  writes: Array<{ bytes: number; path: string }>;
} {
  const commands: string[] = [];
  const writes: Array<{ bytes: number; path: string }> = [];
  return {
    commands,
    writes,
    readFileToBuffer: async (input) =>
      await fs.readFile(path.join(root, input.path)),
    runCommand: async (input) => {
      commands.push([input.cmd, ...(input.args ?? [])].join(" "));
      try {
        const { stderr, stdout } = await run(input.cmd, input.args ?? [], {
          cwd: root,
        });
        return { exitCode: 0, stderr, stdout };
      } catch (error) {
        const failed = error as { code?: number; stderr?: string };
        return {
          exitCode: failed.code ?? 1,
          stderr: failed.stderr ?? "",
          stdout: "",
        };
      }
    },
    writeFiles: async (files) => {
      for (const file of files) {
        const target = path.join(root, file.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, file.content);
        writes.push({
          bytes: Buffer.byteLength(file.content),
          path: file.path,
        });
      }
    },
  };
}
