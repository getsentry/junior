import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COMMAND_PROXY_ACTIVE_PROVIDERS_ENV } from "@/chat/sandbox/command-proxy-env";
import { buildCommandProxyWrapper } from "@/chat/sandbox/command-proxy-wrapper";

describe("command proxy wrapper", () => {
  it("does not contain sandbox-visible activation credentials", () => {
    const wrapper = buildCommandProxyWrapper({
      command: "gh",
      provider: "github",
    });

    expect(wrapper).toContain("JUNIOR_COMMAND_PROXY_ACTIVE_PROVIDERS");
    expect(wrapper).toContain("JUNIOR_COMMAND_PROXY_AUTH_REQUIRED");
    expect(wrapper).not.toContain("JUNIOR_COMMAND_PROXY_TOKEN");
    expect(wrapper).not.toContain("JUNIOR_COMMAND_PROXY_ENDPOINT");
    expect(wrapper).not.toContain("fetch(");
  });

  it("emits the auth-required marker before resolving the real command", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "junior-proxy-"));
    const wrapperPath = path.join(root, "sentry");
    fs.writeFileSync(
      wrapperPath,
      buildCommandProxyWrapper({
        command: "sentry",
        provider: "sentry",
      }),
    );

    const result = spawnSync(process.execPath, [wrapperPath], {
      env: {
        ...process.env,
        JUNIOR_COMMAND_PROXY_AUTH_REQUIRED_PROVIDERS: "sentry",
        PATH: root,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(91);
    expect(result.stderr).toContain(
      "JUNIOR_COMMAND_PROXY_AUTH_REQUIRED provider=sentry",
    );
  });

  it("resolves the real command after the wrapper directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "junior-proxy-"));
    const wrapperDir = path.join(root, "wrapper");
    const realDir = path.join(root, "real");
    fs.mkdirSync(wrapperDir);
    fs.mkdirSync(realDir);

    const outputPath = path.join(root, "argv.json");
    const wrapperPath = path.join(wrapperDir, "gh");
    const realPath = path.join(realDir, "gh");
    fs.writeFileSync(
      wrapperPath,
      buildCommandProxyWrapper({
        command: "gh",
        provider: "github",
      }),
    );
    fs.writeFileSync(
      realPath,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "fs.writeFileSync(process.env.WRAPPER_OUTPUT_PATH, JSON.stringify(process.argv.slice(2)));",
      ].join("\n"),
    );
    fs.chmodSync(realPath, 0o755);

    const result = spawnSync(
      process.execPath,
      [wrapperPath, "issue", "view", "319"],
      {
        env: {
          ...process.env,
          [COMMAND_PROXY_ACTIVE_PROVIDERS_ENV]: "github",
          PATH: [wrapperDir, realDir, process.env.PATH ?? ""].join(
            path.delimiter,
          ),
          WRAPPER_OUTPUT_PATH: outputPath,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toEqual([
      "issue",
      "view",
      "319",
    ]);
  });
});
