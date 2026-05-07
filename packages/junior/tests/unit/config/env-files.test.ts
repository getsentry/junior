import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEnvFileLoader } from "@/env/files";

const TEST_ENV_KEYS = ["ENV_FILE_PRECEDENCE", "ENV_FILE_EXISTING"];
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
