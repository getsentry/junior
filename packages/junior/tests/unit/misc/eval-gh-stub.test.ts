import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildEvalGitHubCliStub } from "@/chat/sandbox/eval-gh-stub";

const execFileAsync = promisify(execFile);

describe("buildEvalGitHubCliStub", () => {
  it("returns an empty object for unhandled gh api routes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "junior-gh-stub-"));
    const stubPath = path.join(tempDir, "gh");

    try {
      await fs.writeFile(stubPath, buildEvalGitHubCliStub(), "utf8");

      const result = await execFileAsync("node", [
        stubPath,
        "api",
        "/repos/getsentry/junior/pulls/170",
      ]);

      expect(JSON.parse(result.stdout)).toEqual({});
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
