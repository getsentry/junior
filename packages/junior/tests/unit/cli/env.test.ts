import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCliEnvFiles } from "@/cli/env";

const TEST_ENV_KEYS = [
  "CLI_ENV_APP_ONLY",
  "CLI_ENV_WORKSPACE_ONLY",
  "CLI_ENV_PRIORITY",
  "CLI_ENV_EXISTING",
  "CLI_ENV_MODE",
];

const originalNodeEnv = process.env.NODE_ENV;
const mutableEnv = process.env as Record<string, string | undefined>;

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function clearTestEnv(): void {
  for (const key of TEST_ENV_KEYS) {
    delete process.env[key];
  }
}

describe("loadCliEnvFiles", () => {
  afterEach(() => {
    clearTestEnv();
    if (originalNodeEnv === undefined) {
      delete mutableEnv.NODE_ENV;
      return;
    }

    mutableEnv.NODE_ENV = originalNodeEnv;
  });

  it("loads app and workspace env files for monorepo CLI execution", () => {
    clearTestEnv();
    delete mutableEnv.NODE_ENV;

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "junior-cli-env-"));
    const workspaceRoot = path.join(tempRoot, "repo");
    const appRoot = path.join(workspaceRoot, "apps", "example");
    const nestedCwd = path.join(appRoot, "scripts");

    writeFile(
      path.join(workspaceRoot, "pnpm-workspace.yaml"),
      'packages:\n  - "apps/*"\n',
    );
    writeFile(path.join(workspaceRoot, "package.json"), "{}\n");
    writeFile(
      path.join(workspaceRoot, ".env.local"),
      [
        "CLI_ENV_WORKSPACE_ONLY=workspace-local",
        "CLI_ENV_PRIORITY=workspace-local",
        "",
      ].join("\n"),
    );

    writeFile(path.join(appRoot, "package.json"), "{}\n");
    writeFile(
      path.join(appRoot, ".env.local"),
      ["CLI_ENV_APP_ONLY=app-local", "CLI_ENV_PRIORITY=app-local", ""].join(
        "\n",
      ),
    );

    process.env.CLI_ENV_EXISTING = "shell";

    loadCliEnvFiles(nestedCwd);

    expect(process.env.CLI_ENV_APP_ONLY).toBe("app-local");
    expect(process.env.CLI_ENV_WORKSPACE_ONLY).toBe("workspace-local");
    expect(process.env.CLI_ENV_PRIORITY).toBe("app-local");
    expect(process.env.CLI_ENV_EXISTING).toBe("shell");
  });

  it("prefers test env files over .env.local in test mode", () => {
    clearTestEnv();
    mutableEnv.NODE_ENV = "test";

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "junior-cli-env-"));
    writeFile(path.join(tempRoot, "package.json"), "{}\n");
    writeFile(
      path.join(tempRoot, ".env.local"),
      ["CLI_ENV_MODE=local", ""].join("\n"),
    );
    writeFile(
      path.join(tempRoot, ".env.test.local"),
      ["CLI_ENV_MODE=test-local", ""].join("\n"),
    );

    loadCliEnvFiles(tempRoot);

    expect(process.env.CLI_ENV_MODE).toBe("test-local");
  });
});
