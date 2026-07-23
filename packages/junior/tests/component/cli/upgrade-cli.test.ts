import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveUpgradePluginSet } from "@/cli/upgrade";

const ORIGINAL_CWD = process.cwd();

describe("upgrade CLI", () => {
  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
  });

  it("loads source app plugins when virtual config is unavailable", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "junior-upgrade-plugins-"));
    writeFileSync(
      path.join(tempDir, "plugins.ts"),
      `const packageNames: string[] = ["@acme/junior-upgrade"];

export const plugins = {
  packageNames,
  registrations: [],
};
`,
    );
    process.chdir(tempDir);

    try {
      await expect(resolveUpgradePluginSet()).resolves.toMatchObject({
        packageNames: ["@acme/junior-upgrade"],
        registrations: [],
      });
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
