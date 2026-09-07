import { describe, expect, it } from "vitest";
import {
  workspaceSetupCommand,
  workspaceSetupFailureDetail,
  workspaceSnapshotSetupCommand,
} from "@/chat/sandbox/prepare-workspace";

describe("Workspace snapshot setup command", () => {
  it("keeps a bounded tail of stdout and stderr on failure", () => {
    const detail = workspaceSetupFailureDetail({
      exitCode: 1,
      stdout: `old output\n${"x".repeat(8_000)}`,
      stderr: "ERR_WORKER_OUT_OF_MEMORY",
    });

    expect(detail).toHaveLength(7_000);
    expect(detail.startsWith("[earlier setup output truncated]\n")).toBe(true);
    expect(detail).not.toContain("old output");
    expect(detail.endsWith("stderr:\nERR_WORKER_OUT_OF_MEMORY")).toBe(true);
  });

  it("uses the exit code when the command has no output", () => {
    expect(
      workspaceSetupFailureDetail({ exitCode: 7, stdout: "", stderr: "" }),
    ).toBe("exit 7");
  });

  it("uses one stable lock and result for repeated launches", () => {
    const command = workspaceSnapshotSetupCommand(
      {
        id: "workspace-one",
        name: "one",
        setupScript: "printf ready",
        repos: [],
        snapshot: null,
      },
      "build-one",
    );

    expect(command.args.at(-1)).toBe("printf ready");
    expect(command.env.NODE_OPTIONS).toBe("--max-old-space-size=4096");
    expect(command.args.join("\n")).toContain(
      "/tmp/junior-snapshot-build-build-one/lock",
    );
    expect(command.args.join("\n")).toContain(
      "/tmp/junior-snapshot-build-build-one/exit",
    );
  });

  it("gives regular Workspace setup commands more Node heap", () => {
    const command = workspaceSetupCommand({
      id: "workspace-one",
      name: "one",
      setupScript: "printf ready",
      repos: [],
      snapshot: null,
    });

    expect(command.env.NODE_OPTIONS).toBe("--max-old-space-size=4096");
  });
});
