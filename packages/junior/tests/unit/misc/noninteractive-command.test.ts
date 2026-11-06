import { describe, expect, it, vi } from "vitest";
import {
  buildNonInteractiveShellScript,
  runNonInteractiveCommand,
} from "@/chat/sandbox/noninteractive-command";

describe("non-interactive shell commands", () => {
  it("builds shell scripts with closed stdin and non-interactive env", () => {
    const script = buildNonInteractiveShellScript("echo ok", {
      env: { CUSTOM_TOKEN: "secret-value" },
      path: "/custom/bin:$PATH",
    });

    expect(script).toContain('export PATH="/custom/bin:$PATH"');
    expect(script).toContain("export CI='1'");
    expect(script).toContain("export TERM='dumb'");
    expect(script).toContain("export GH_PROMPT_DISABLED='1'");
    expect(script).toContain("export GIT_TERMINAL_PROMPT='0'");
    expect(script).toContain("export DEBIAN_FRONTEND='noninteractive'");
    expect(script).toContain("export GIT_ASKPASS='/bin/true'");
    expect(script).toContain("export GIT_CONFIG_NOSYSTEM='1'");
    expect(script).toContain("export GIT_CONFIG_COUNT='2'");
    expect(script).toContain("export GIT_CONFIG_KEY_0='credential.helper'");
    expect(script).toContain("export GIT_CONFIG_VALUE_0=''");
    expect(script).toContain("export GIT_CONFIG_KEY_1='http.emptyAuth'");
    expect(script).toContain("export GIT_CONFIG_VALUE_1='true'");
    expect(script).toContain("export CUSTOM_TOKEN='secret-value'");
    expect(script).toContain("exec </dev/null");
    expect(script).toContain("echo ok");
  });

  it("adds command Git config before the runtime Git config", async () => {
    const { spawnSync } = await import("node:child_process");
    const script = buildNonInteractiveShellScript(
      "git config core.hooksPath && git config credential.helper; git config http.emptyAuth",
      {
        env: {
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "core.hooksPath",
          GIT_CONFIG_VALUE_0: "/junior/git-hooks",
          GIT_CONFIG_KEY_1: "credential.helper",
          GIT_CONFIG_VALUE_1: "store",
        },
      },
    );

    const result = spawnSync("bash", ["-c", script]);

    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toBe("/junior/git-hooks\n\ntrue\n");
  });

  it("wraps argv commands in a non-interactive bash invocation", async () => {
    const runCommand = vi.fn(async () => ({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    }));

    await runNonInteractiveCommand(
      { runCommand },
      {
        cmd: "file",
        args: ["--mime-type", "-b", "/tmp/report.pdf"],
      },
    );

    expect(runCommand).toHaveBeenCalledWith({
      cmd: "bash",
      args: [
        "-c",
        expect.stringContaining("'file' '--mime-type' '-b' '/tmp/report.pdf'"),
      ],
    });
  });

  it("passes cancellation and a timeout to the sandbox command", async () => {
    const runCommand = vi.fn(async () => ({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    }));
    const signal = new AbortController().signal;

    await runNonInteractiveCommand(
      { runCommand },
      { cmd: "echo", args: ["ok"], signal, timeoutMs: 12_345 },
    );

    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ signal, timeoutMs: 12_345 }),
    );
  });
});
