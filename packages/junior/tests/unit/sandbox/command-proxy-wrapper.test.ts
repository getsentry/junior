import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COMMAND_PROXY_ACTIVATE_PREFIX } from "@/chat/sandbox/command-proxy-protocol";
import { buildCommandProxyWrapper } from "@/chat/sandbox/command-proxy-wrapper";

async function runWrapper(input: {
  wrapperPath: string;
  args?: string[];
  env?: Record<string, string>;
  ack: Record<string, unknown>;
}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [input.wrapperPath, ...(input.args ?? [])],
      {
        env: {
          ...process.env,
          ...(input.env ?? {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    let stderrBuffer = "";

    const maybeAck = (text: string) => {
      stderrBuffer += text;
      while (true) {
        const newlineIndex = stderrBuffer.indexOf("\n");
        if (newlineIndex < 0) {
          return;
        }
        const line = stderrBuffer.slice(0, newlineIndex);
        stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
        if (!line.startsWith(COMMAND_PROXY_ACTIVATE_PREFIX)) {
          continue;
        }
        const request = JSON.parse(
          line.slice(COMMAND_PROXY_ACTIVATE_PREFIX.length),
        ) as { id: string };
        const ackDir = path.join(
          path.dirname(path.dirname(input.wrapperPath)),
          "run",
          "command-proxy",
        );
        fs.mkdirSync(ackDir, { recursive: true });
        fs.writeFileSync(
          path.join(ackDir, `${request.id}.json`),
          JSON.stringify(input.ack),
        );
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      maybeAck(text);
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

describe("command proxy wrapper", () => {
  it("does not contain sandbox-visible activation credentials", () => {
    const wrapper = buildCommandProxyWrapper({
      command: "gh",
      provider: "github",
    });

    expect(wrapper).toContain("JUNIOR_COMMAND_PROXY_ACTIVATE");
    expect(wrapper).not.toContain("JUNIOR_COMMAND_PROXY_ACTIVE_PROVIDERS");
    expect(wrapper).not.toContain(
      "JUNIOR_COMMAND_PROXY_AUTH_REQUIRED_PROVIDERS",
    );
    expect(wrapper).not.toContain("JUNIOR_COMMAND_PROXY_TOKEN");
    expect(wrapper).not.toContain("JUNIOR_COMMAND_PROXY_ENDPOINT");
    expect(wrapper).not.toContain("fetch(");
  });

  it("exits before the real command when activation requires auth", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "junior-proxy-"));
    const wrapperDir = path.join(root, "wrapper");
    const realDir = path.join(root, "real");
    fs.mkdirSync(wrapperDir);
    fs.mkdirSync(realDir);

    const outputPath = path.join(root, "real-ran");
    const wrapperPath = path.join(wrapperDir, "sentry");
    const realPath = path.join(realDir, "sentry");
    fs.writeFileSync(
      wrapperPath,
      buildCommandProxyWrapper({
        command: "sentry",
        provider: "sentry",
      }),
    );
    fs.writeFileSync(
      realPath,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "fs.writeFileSync(process.env.WRAPPER_OUTPUT_PATH, 'ran');",
      ].join("\n"),
    );
    fs.chmodSync(realPath, 0o755);

    const result = await runWrapper({
      wrapperPath,
      env: {
        PATH: [wrapperDir, realDir, process.env.PATH ?? ""].join(
          path.delimiter,
        ),
        WRAPPER_OUTPUT_PATH: outputPath,
      },
      ack: {
        status: "auth_required",
        provider: "sentry",
        message: "No sentry credentials available. Connect sentry and retry.",
      },
    });

    expect(result.status).toBe(91);
    expect(result.stderr).toContain("No sentry credentials available");
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("resolves the real command after activation", async () => {
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
        "fs.writeFileSync(process.env.WRAPPER_OUTPUT_PATH, JSON.stringify({ args: process.argv.slice(2), token: process.env.GITHUB_TOKEN }));",
      ].join("\n"),
    );
    fs.chmodSync(realPath, 0o755);

    const result = await runWrapper({
      wrapperPath,
      args: ["issue", "view", "319"],
      env: {
        PATH: [wrapperDir, realDir, process.env.PATH ?? ""].join(
          path.delimiter,
        ),
        WRAPPER_OUTPUT_PATH: outputPath,
      },
      ack: {
        status: "ok",
        provider: "github",
        env: { GITHUB_TOKEN: "ghp_host_managed_credential" },
      },
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toEqual({
      args: ["issue", "view", "319"],
      token: "ghp_host_managed_credential",
    });
  });

  it("does not emit provider markers when the real command fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "junior-proxy-"));
    const wrapperDir = path.join(root, "wrapper");
    const realDir = path.join(root, "real");
    fs.mkdirSync(wrapperDir);
    fs.mkdirSync(realDir);

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
        'process.stderr.write("bad credentials\\n");',
        "process.exit(1);",
      ].join("\n"),
    );
    fs.chmodSync(realPath, 0o755);

    const result = await runWrapper({
      wrapperPath,
      env: {
        PATH: [wrapperDir, realDir, process.env.PATH ?? ""].join(
          path.delimiter,
        ),
      },
      ack: {
        status: "ok",
        provider: "github",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("bad credentials");
    expect(result.stderr).not.toContain("JUNIOR_COMMAND_PROXY_PROVIDER");
  });
});
