import { describe, expect, it, vi } from "vitest";
import { CLI_USAGE, runCli } from "@/cli/run";

describe("cli command dispatch", () => {
  it("runs init with a single directory argument", async () => {
    const runInit = vi.fn(async () => undefined);
    const runSnapshotCreate = vi.fn(async () => undefined);

    const exitCode = await runCli(["init", "my-bot"], { runInit, runSnapshotCreate });

    expect(exitCode).toBe(0);
    expect(runInit).toHaveBeenCalledTimes(1);
    expect(runInit).toHaveBeenCalledWith("my-bot");
    expect(runSnapshotCreate).not.toHaveBeenCalled();
  });

  it("runs snapshot create", async () => {
    const runInit = vi.fn(async () => undefined);
    const runSnapshotCreate = vi.fn(async () => undefined);

    const exitCode = await runCli(["snapshot", "create"], { runInit, runSnapshotCreate });

    expect(exitCode).toBe(0);
    expect(runSnapshotCreate).toHaveBeenCalledTimes(1);
    expect(runInit).not.toHaveBeenCalled();
  });

  it("returns usage for invalid argv forms", async () => {
    const runInit = vi.fn(async () => undefined);
    const runSnapshotCreate = vi.fn(async () => undefined);
    const lines: string[] = [];

    const missingInitArg = await runCli(["init"], { runInit, runSnapshotCreate }, { error: (line) => lines.push(line) });
    const extraInitArg = await runCli(["init", "my-bot", "extra"], { runInit, runSnapshotCreate }, { error: (line) => lines.push(line) });
    const extraSnapshotArg = await runCli(["snapshot", "create", "extra"], { runInit, runSnapshotCreate }, {
      error: (line) => lines.push(line)
    });
    const unknown = await runCli(["whoami"], { runInit, runSnapshotCreate }, { error: (line) => lines.push(line) });

    expect(missingInitArg).toBe(1);
    expect(extraInitArg).toBe(1);
    expect(extraSnapshotArg).toBe(1);
    expect(unknown).toBe(1);
    expect(lines).toEqual([CLI_USAGE, CLI_USAGE, CLI_USAGE, CLI_USAGE]);
    expect(runInit).not.toHaveBeenCalled();
    expect(runSnapshotCreate).not.toHaveBeenCalled();
  });
});
