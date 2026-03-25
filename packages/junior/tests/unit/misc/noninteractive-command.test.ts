import { describe, expect, it, vi } from "vitest";
import {
  buildNonInteractiveShellScript,
  runNonInteractiveCommand,
} from "@/chat/sandbox/noninteractive-command";

describe("non-interactive shell commands", () => {
  it("builds shell scripts with closed stdin and non-interactive env", () => {
    const script = buildNonInteractiveShellScript("echo ok", {
      env: { CUSTOM_TOKEN: "secret-value" },
      pathPrefix: "/custom/bin:$PATH",
    });

    expect(script).toContain('export PATH="/custom/bin:$PATH"');
    expect(script).toContain("export CI='1'");
    expect(script).toContain("export TERM='dumb'");
    expect(script).toContain("export GH_PROMPT_DISABLED='1'");
    expect(script).toContain("export GIT_TERMINAL_PROMPT='0'");
    expect(script).toContain("export DEBIAN_FRONTEND='noninteractive'");
    expect(script).toContain("export CUSTOM_TOKEN='secret-value'");
    expect(script).toContain("exec </dev/null");
    expect(script).toContain("echo ok");
  });

  it("wraps argv commands in a non-interactive bash invocation", async () => {
    const runCommand = vi.fn(async () => ({
      exitCode: 0,
      stdout: async () => "ok",
      stderr: async () => "",
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
});
