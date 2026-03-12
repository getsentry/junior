import { describe, expect, it, vi } from "vitest";
import { CLI_USAGE, runCli } from "@/cli/run";

describe("cli command dispatch", () => {
  it("runs init with a single directory argument", async () => {
    const runInit = vi.fn(async () => undefined);
    const runSnapshotCreate = vi.fn(async () => undefined);
    const runCheck = vi.fn(async () => undefined);

    const exitCode = await runCli(["init", "my-bot"], { runInit, runSnapshotCreate, runCheck });

    expect(exitCode).toBe(0);
    expect(runInit).toHaveBeenCalledTimes(1);
    expect(runInit).toHaveBeenCalledWith("my-bot");
    expect(runSnapshotCreate).not.toHaveBeenCalled();
    expect(runCheck).not.toHaveBeenCalled();
  });

  it("runs snapshot create", async () => {
    const runInit = vi.fn(async () => undefined);
    const runSnapshotCreate = vi.fn(async () => undefined);
    const runCheck = vi.fn(async () => undefined);

    const exitCode = await runCli(["snapshot", "create"], { runInit, runSnapshotCreate, runCheck });

    expect(exitCode).toBe(0);
    expect(runSnapshotCreate).toHaveBeenCalledTimes(1);
    expect(runInit).not.toHaveBeenCalled();
    expect(runCheck).not.toHaveBeenCalled();
  });

  it("runs check with and without a directory argument", async () => {
    const runInit = vi.fn(async () => undefined);
    const runSnapshotCreate = vi.fn(async () => undefined);
    const runCheck = vi.fn(async () => undefined);

    const explicitExitCode = await runCli(["check", "/tmp/repo"], { runInit, runSnapshotCreate, runCheck });
    const implicitExitCode = await runCli(["check"], { runInit, runSnapshotCreate, runCheck });

    expect(explicitExitCode).toBe(0);
    expect(implicitExitCode).toBe(0);
    expect(runCheck).toHaveBeenNthCalledWith(1, "/tmp/repo");
    expect(runCheck).toHaveBeenNthCalledWith(2, undefined);
    expect(runInit).not.toHaveBeenCalled();
    expect(runSnapshotCreate).not.toHaveBeenCalled();
  });

  it("returns usage for invalid argv forms", async () => {
    const runInit = vi.fn(async () => undefined);
    const runSnapshotCreate = vi.fn(async () => undefined);
    const runCheck = vi.fn(async () => undefined);
    const lines: string[] = [];

    const missingInitArg = await runCli(["init"], { runInit, runSnapshotCreate, runCheck }, { error: (line) => lines.push(line) });
    const extraInitArg = await runCli(["init", "my-bot", "extra"], { runInit, runSnapshotCreate, runCheck }, { error: (line) => lines.push(line) });
    const extraSnapshotArg = await runCli(["snapshot", "create", "extra"], { runInit, runSnapshotCreate, runCheck }, {
      error: (line) => lines.push(line)
    });
    const extraCheckArg = await runCli(["check", "repo", "extra"], { runInit, runSnapshotCreate, runCheck }, {
      error: (line) => lines.push(line)
    });
    const unknown = await runCli(["whoami"], { runInit, runSnapshotCreate, runCheck }, { error: (line) => lines.push(line) });

    expect(missingInitArg).toBe(1);
    expect(extraInitArg).toBe(1);
    expect(extraSnapshotArg).toBe(1);
    expect(extraCheckArg).toBe(1);
    expect(unknown).toBe(1);
    expect(lines).toEqual([CLI_USAGE, CLI_USAGE, CLI_USAGE, CLI_USAGE, CLI_USAGE]);
    expect(runInit).not.toHaveBeenCalled();
    expect(runSnapshotCreate).not.toHaveBeenCalled();
    expect(runCheck).not.toHaveBeenCalled();
  });
});
