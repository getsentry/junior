import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEnvFileLoader } from "@/env/files";
import { loadJuniorTestEnvFiles } from "../../fixtures/env";

const TEST_ENV_KEYS = [
  "ENV_FILE_PRECEDENCE",
  "ENV_FILE_EXISTING",
  "ENV_FILE_DEFAULT",
];
const originalEnv = { ...process.env };

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function clearTestEnv(): void {
  for (const key of TEST_ENV_KEYS) {
    delete process.env[key];
  }
}

describe("createEnvFileLoader", () => {
  afterEach(() => {
    clearTestEnv();
    process.env = { ...originalEnv };
  });

  it("lets later files override earlier values", () => {
    const applyEnvFile = createEnvFileLoader();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "junior-env-file-"));
    const baseEnv = path.join(tempRoot, ".env");
    const localEnv = path.join(tempRoot, ".env.local");

    writeFile(baseEnv, ["ENV_FILE_PRECEDENCE=base", ""].join("\n"));
    writeFile(localEnv, ["ENV_FILE_PRECEDENCE=local", ""].join("\n"));

    applyEnvFile(baseEnv);
    applyEnvFile(localEnv);

    expect(process.env.ENV_FILE_PRECEDENCE).toBe("local");
  });

  it("preserves an existing shell value", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "junior-env-file-"));
    const envFile = path.join(tempRoot, ".env.local");

    writeFile(envFile, ["ENV_FILE_EXISTING=file", ""].join("\n"));
    process.env.ENV_FILE_EXISTING = "shell";
    const applyEnvFile = createEnvFileLoader();

    applyEnvFile(envFile);

    expect(process.env.ENV_FILE_EXISTING).toBe("shell");
  });
});

describe("loadJuniorTestEnvFiles", () => {
  afterEach(() => {
    clearTestEnv();
    process.env = { ...originalEnv };
  });

  it("loads example env files as defaults before local overrides", () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "junior-workspace-env-"),
    );
    const exampleRoot = path.join(workspaceRoot, "apps/example");

    writeFile(
      path.join(exampleRoot, ".env.example"),
      ["ENV_FILE_DEFAULT=example", ""].join("\n"),
    );
    writeFile(
      path.join(exampleRoot, ".env.local"),
      ["ENV_FILE_DEFAULT=local", ""].join("\n"),
    );

    loadJuniorTestEnvFiles({ workspaceRoot, packageRoots: [] });

    expect(process.env.ENV_FILE_DEFAULT).toBe("local");
  });

  it("does not let later example files override existing defaults", () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "junior-workspace-env-"),
    );
    const exampleRoot = path.join(workspaceRoot, "apps/example");
    const packageRoot = path.join(workspaceRoot, "packages/junior");

    writeFile(
      path.join(exampleRoot, ".env.example"),
      ["ENV_FILE_DEFAULT=example", ""].join("\n"),
    );
    writeFile(
      path.join(packageRoot, ".env.example"),
      ["ENV_FILE_DEFAULT=", ""].join("\n"),
    );

    loadJuniorTestEnvFiles({ workspaceRoot, packageRoots: [packageRoot] });

    expect(process.env.ENV_FILE_DEFAULT).toBe("example");
  });
});
