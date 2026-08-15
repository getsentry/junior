import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyJuniorDevelopmentDefaults,
  JUNIOR_LOCAL_DEV_HEARTBEAT_SECRET,
  JUNIOR_LOCAL_DEV_INTERNAL_SECRET,
  loadCliEnvFiles,
} from "@/cli/env";

const TEST_ENV_KEYS = [
  "CRON_SECRET",
  "CLI_ENV_APP_ONLY",
  "CLI_ENV_WORKSPACE_ONLY",
  "CLI_ENV_PRIORITY",
  "CLI_ENV_EXISTING",
  "CLI_ENV_MODE",
  "CLI_ENV_DEFAULT",
  "JUNIOR_BASE_URL",
  "JUNIOR_SCHEDULER_SECRET",
  "JUNIOR_SECRET",
  "JUNIOR_STATE_ADAPTER",
];

const originalNodeEnv = process.env.NODE_ENV;
const mutableEnv = process.env as Record<string, string | undefined>;
const originalEnv = new Map(
  TEST_ENV_KEYS.map((key) => [key, process.env[key]] as const),
);

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function clearTestEnv(): void {
  for (const key of TEST_ENV_KEYS) {
    delete process.env[key];
  }
}

function restoreTestEnv(): void {
  for (const key of TEST_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

describe("loadCliEnvFiles", () => {
  afterEach(() => {
    restoreTestEnv();
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

  it("loads example env files as last-resort defaults", () => {
    clearTestEnv();
    delete mutableEnv.NODE_ENV;

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "junior-cli-env-"));
    writeFile(path.join(tempRoot, "package.json"), "{}\n");
    writeFile(
      path.join(tempRoot, ".env.example"),
      ["CLI_ENV_DEFAULT=example", "CLI_ENV_PRIORITY=example", ""].join("\n"),
    );
    writeFile(
      path.join(tempRoot, ".env"),
      ["CLI_ENV_PRIORITY=local", ""].join("\n"),
    );

    loadCliEnvFiles(tempRoot);

    expect(process.env.CLI_ENV_DEFAULT).toBe("example");
    expect(process.env.CLI_ENV_PRIORITY).toBe("local");
  });

  it("applies development defaults after loading env files", () => {
    clearTestEnv();
    delete mutableEnv.NODE_ENV;

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "junior-cli-env-"));
    writeFile(path.join(tempRoot, "package.json"), "{}\n");

    loadCliEnvFiles(tempRoot);

    expect(process.env.JUNIOR_SECRET).toBe(JUNIOR_LOCAL_DEV_INTERNAL_SECRET);
    expect(process.env.JUNIOR_STATE_ADAPTER).toBe("memory");
    expect(process.env.JUNIOR_SCHEDULER_SECRET).toBe(
      JUNIOR_LOCAL_DEV_HEARTBEAT_SECRET,
    );
  });

  it("preserves explicit config values when applying defaults", () => {
    clearTestEnv();
    delete mutableEnv.NODE_ENV;

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "junior-cli-env-"));
    writeFile(path.join(tempRoot, "package.json"), "{}\n");
    writeFile(
      path.join(tempRoot, ".env.local"),
      [
        "JUNIOR_SECRET=explicit-secret",
        "JUNIOR_STATE_ADAPTER=redis",
        "CRON_SECRET=cron-secret",
        "",
      ].join("\n"),
    );

    loadCliEnvFiles(tempRoot);

    expect(process.env.JUNIOR_SECRET).toBe("explicit-secret");
    expect(process.env.JUNIOR_STATE_ADAPTER).toBe("redis");
    expect(process.env.CRON_SECRET).toBe("cron-secret");
    expect(process.env.JUNIOR_SCHEDULER_SECRET).toBeUndefined();
  });
});

describe("applyJuniorDevelopmentDefaults", () => {
  afterEach(() => {
    restoreTestEnv();
    if (originalNodeEnv === undefined) {
      delete mutableEnv.NODE_ENV;
      return;
    }

    mutableEnv.NODE_ENV = originalNodeEnv;
  });

  it("does not apply development defaults outside development", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
    };

    applyJuniorDevelopmentDefaults(env, {
      baseUrl: "http://localhost:3000",
    });

    expect(env.JUNIOR_SECRET).toBeUndefined();
    expect(env.JUNIOR_STATE_ADAPTER).toBeUndefined();
    expect(env.JUNIOR_SCHEDULER_SECRET).toBeUndefined();
    expect(env.JUNIOR_BASE_URL).toBeUndefined();
  });

  it("applies a base URL only when the caller provides one", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "development",
    };

    applyJuniorDevelopmentDefaults(env);

    expect(env.JUNIOR_BASE_URL).toBeUndefined();

    applyJuniorDevelopmentDefaults(env, {
      baseUrl: "http://localhost:3000",
    });

    expect(env.JUNIOR_BASE_URL).toBe("http://localhost:3000");
  });
});
