import { describe, expect, it, vi } from "vitest";
import { CLI_USAGE, runCli } from "@/cli/run";

describe("cli command dispatch", () => {
  function handlers() {
    return {
      runInit: vi.fn(async () => undefined),
      runSnapshotCreate: vi.fn(async () => undefined),
      runCheck: vi.fn(async () => undefined),
      runUpgrade: vi.fn(async () => undefined),
    };
  }

  it("runs init with a single directory argument", async () => {
    const cliHandlers = handlers();

    const exitCode = await runCli(["init", "my-bot"], cliHandlers);

    expect(exitCode).toBe(0);
    expect(cliHandlers.runInit).toHaveBeenCalledTimes(1);
    expect(cliHandlers.runInit).toHaveBeenCalledWith("my-bot");
    expect(cliHandlers.runSnapshotCreate).not.toHaveBeenCalled();
    expect(cliHandlers.runCheck).not.toHaveBeenCalled();
    expect(cliHandlers.runUpgrade).not.toHaveBeenCalled();
  });

  it("runs snapshot create", async () => {
    const cliHandlers = handlers();

    const exitCode = await runCli(["snapshot", "create"], cliHandlers);

    expect(exitCode).toBe(0);
    expect(cliHandlers.runSnapshotCreate).toHaveBeenCalledTimes(1);
    expect(cliHandlers.runInit).not.toHaveBeenCalled();
    expect(cliHandlers.runCheck).not.toHaveBeenCalled();
    expect(cliHandlers.runUpgrade).not.toHaveBeenCalled();
  });

  it("runs check with and without a directory argument", async () => {
    const cliHandlers = handlers();

    const explicitExitCode = await runCli(["check", "/tmp/repo"], cliHandlers);
    const implicitExitCode = await runCli(["check"], cliHandlers);

    expect(explicitExitCode).toBe(0);
    expect(implicitExitCode).toBe(0);
    expect(cliHandlers.runCheck).toHaveBeenNthCalledWith(1, "/tmp/repo");
    expect(cliHandlers.runCheck).toHaveBeenNthCalledWith(2, undefined);
    expect(cliHandlers.runInit).not.toHaveBeenCalled();
    expect(cliHandlers.runSnapshotCreate).not.toHaveBeenCalled();
    expect(cliHandlers.runUpgrade).not.toHaveBeenCalled();
  });

  it("runs upgrade", async () => {
    const cliHandlers = handlers();

    const exitCode = await runCli(["upgrade"], cliHandlers);

    expect(exitCode).toBe(0);
    expect(cliHandlers.runUpgrade).toHaveBeenCalledTimes(1);
    expect(cliHandlers.runInit).not.toHaveBeenCalled();
    expect(cliHandlers.runSnapshotCreate).not.toHaveBeenCalled();
    expect(cliHandlers.runCheck).not.toHaveBeenCalled();
  });

  it("returns usage for invalid argv forms", async () => {
    const cliHandlers = handlers();
    const lines: string[] = [];

    const missingInitArg = await runCli(["init"], cliHandlers, {
      error: (line) => lines.push(line),
    });
    const extraInitArg = await runCli(
      ["init", "my-bot", "extra"],
      cliHandlers,
      { error: (line) => lines.push(line) },
    );
    const extraSnapshotArg = await runCli(
      ["snapshot", "create", "extra"],
      cliHandlers,
      {
        error: (line) => lines.push(line),
      },
    );
    const extraCheckArg = await runCli(
      ["check", "repo", "extra"],
      cliHandlers,
      {
        error: (line) => lines.push(line),
      },
    );
    const extraUpgradeArg = await runCli(["upgrade", "extra"], cliHandlers, {
      error: (line) => lines.push(line),
    });
    const unknown = await runCli(["whoami"], cliHandlers, {
      error: (line) => lines.push(line),
    });

    expect(missingInitArg).toBe(1);
    expect(extraInitArg).toBe(1);
    expect(extraSnapshotArg).toBe(1);
    expect(extraCheckArg).toBe(1);
    expect(extraUpgradeArg).toBe(1);
    expect(unknown).toBe(1);
    expect(lines).toEqual([
      CLI_USAGE,
      CLI_USAGE,
      CLI_USAGE,
      CLI_USAGE,
      CLI_USAGE,
      CLI_USAGE,
    ]);
    expect(cliHandlers.runInit).not.toHaveBeenCalled();
    expect(cliHandlers.runSnapshotCreate).not.toHaveBeenCalled();
    expect(cliHandlers.runCheck).not.toHaveBeenCalled();
    expect(cliHandlers.runUpgrade).not.toHaveBeenCalled();
  });
});
