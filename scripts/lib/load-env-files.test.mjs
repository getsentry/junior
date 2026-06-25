import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadEnvFiles } from "./load-env-files.mjs";

test("app env overrides root env without replacing shell env", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "junior-env-root-"));
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "junior-env-app-"));
  try {
    fs.writeFileSync(
      path.join(root, ".env"),
      [
        "DATABASE_URL=postgres://root.example/db",
        "REDIS_URL=redis://root.example:6379",
        "AI_MODEL=root-model",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(app, ".env"),
      [
        "DATABASE_URL=postgres://app.example/db",
        "REDIS_URL=redis://app.example:6379",
        "JUNIOR_BOT_NAME=junior-example",
      ].join("\n"),
    );

    const env = {
      AI_MODEL: "shell-model",
      NODE_ENV: "development",
    };
    loadEnvFiles([root, app], { env });

    assert.equal(env.DATABASE_URL, "postgres://app.example/db");
    assert.equal(env.REDIS_URL, "redis://app.example:6379");
    assert.equal(env.AI_MODEL, "shell-model");
    assert.equal(env.JUNIOR_BOT_NAME, "junior-example");
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
    fs.rmSync(app, { force: true, recursive: true });
  }
});

test("example env files provide defaults before env overrides", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "junior-env-root-"));
  try {
    fs.writeFileSync(
      path.join(root, ".env.example"),
      [
        "DATABASE_URL=postgres://example.example/db",
        "REDIS_URL=redis://example.example:6379",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(root, ".env"),
      ["DATABASE_URL=postgres://local.example/db"].join("\n"),
    );

    const env = {
      NODE_ENV: "development",
    };
    loadEnvFiles([root], { env });

    assert.equal(env.DATABASE_URL, "postgres://local.example/db");
    assert.equal(env.REDIS_URL, "redis://example.example:6379");
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("later example env files do not replace earlier defaults", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "junior-env-root-"));
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "junior-env-app-"));
  try {
    fs.writeFileSync(
      path.join(root, ".env.example"),
      ["DATABASE_URL=postgres://root.example/db"].join("\n"),
    );
    fs.writeFileSync(
      path.join(app, ".env.example"),
      ["DATABASE_URL=postgres://app.example/db"].join("\n"),
    );

    const env = {
      NODE_ENV: "development",
    };
    loadEnvFiles([app, root], { env });

    assert.equal(env.DATABASE_URL, "postgres://app.example/db");
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
    fs.rmSync(app, { force: true, recursive: true });
  }
});
