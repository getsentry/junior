import { describe, expect, it } from "vitest";
import { workspaceSnapshotSetupCommand } from "@/chat/sandbox/prepare-workspace";

describe("Workspace snapshot setup command", () => {
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
    expect(command.args.join("\n")).toContain(
      "/tmp/junior-snapshot-build-build-one/lock",
    );
    expect(command.args.join("\n")).toContain(
      "/tmp/junior-snapshot-build-build-one/exit",
    );
  });
});
