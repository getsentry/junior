import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { isLinkedDirectory, linkDirectory, resolveInjectedPackageDir } =
  require("../../../../../scripts/lib/injected-package-sync.mjs") as {
    isLinkedDirectory: (sourceDir: string, targetDir: string) => boolean;
    linkDirectory: (sourceDir: string, targetDir: string) => void;
    resolveInjectedPackageDir: (
      packageName: string,
      consumerDir: string,
    ) => string | null;
  };

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "junior-injected-sync-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("injected package sync helpers", () => {
  it("links the target directory to the live source snapshot", () => {
    const tempRoot = makeTempDir();
    const sourceDir = path.join(tempRoot, "source", "dist");
    const targetDir = path.join(tempRoot, "target", "dist");

    writeFile(path.join(sourceDir, "app.js"), "new app");
    writeFile(path.join(sourceDir, "cli", "init.js"), "new init");
    writeFile(path.join(targetDir, "app.js"), "old app");
    writeFile(path.join(targetDir, "stale.js"), "stale");

    linkDirectory(sourceDir, targetDir);

    expect(fs.lstatSync(targetDir).isSymbolicLink()).toBe(true);
    expect(isLinkedDirectory(sourceDir, targetDir)).toBe(true);
    expect(fs.readFileSync(path.join(targetDir, "app.js"), "utf8")).toBe(
      "new app",
    );
    expect(
      fs.readFileSync(path.join(targetDir, "cli", "init.js"), "utf8"),
    ).toBe("new init");
  });

  it("resolves the real injected package directory through the consumer entry", () => {
    const tempRoot = makeTempDir();
    const consumerDir = path.join(tempRoot, "consumer");
    const injectedPackageDir = path.join(
      tempRoot,
      "store",
      "@sentry",
      "junior",
    );
    const symlinkDir = path.join(
      consumerDir,
      "node_modules",
      "@sentry",
      "junior",
    );

    fs.mkdirSync(injectedPackageDir, { recursive: true });
    fs.mkdirSync(path.dirname(symlinkDir), { recursive: true });
    fs.symlinkSync(injectedPackageDir, symlinkDir, "dir");

    expect(resolveInjectedPackageDir("@sentry/junior", consumerDir)).toBe(
      fs.realpathSync(injectedPackageDir),
    );
  });
});
