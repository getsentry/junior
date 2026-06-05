import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { runCheck } from "@/cli/check";

const tempRoots: string[] = [];

function checkLogger(lines: string[]) {
  return {
    info: (line: string) => lines.push(line),
    warn: (line: string) => lines.push(line),
    error: (line: string) => lines.push(line),
  };
}

/** Create a temporary repository root for CLI check tests. */
export function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

/** Remove all temporary repository roots created by CLI check tests. */
export function cleanupCheckCliTempRoots(): void {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Ensure a directory exists inside a CLI check fixture repository. */
export function mkdir(targetPath: string): void {
  fs.mkdirSync(targetPath, { recursive: true });
}

/** Write a fixture file, creating parent directories as needed. */
export function writeFile(targetPath: string, contents: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, contents, "utf8");
}

/** Write the required Junior app markdown files into a fixture repository. */
export function writeAppFiles(repoRoot: string): void {
  const appDir = path.join(repoRoot, "app");
  fs.mkdirSync(appDir, { recursive: true });
  writeFile(path.join(appDir, "SOUL.md"), "soul");
  writeFile(path.join(appDir, "WORLD.md"), "world");
  writeFile(path.join(appDir, "DESCRIPTION.md"), "description");
}

/** Run the check command and return captured logger lines. */
export async function runCheckAndCollect(repoRoot: string): Promise<string[]> {
  const lines: string[] = [];
  await runCheck(repoRoot, checkLogger(lines));
  return lines;
}

/** Assert the check command fails and return captured logger lines. */
export async function expectCheckFailure(
  repoRoot: string,
  expectedMessage: string,
): Promise<string[]> {
  const lines: string[] = [];
  await expect(runCheck(repoRoot, checkLogger(lines))).rejects.toThrow(
    expectedMessage,
  );
  return lines;
}
