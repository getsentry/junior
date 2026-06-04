import { describe, expect, it, vi } from "vitest";
import { createLazySandboxWorkspace } from "@/chat/sandbox/lazy-workspace";
import type { SandboxInstance } from "@/chat/sandbox/workspace";

function createSandbox(id: string): SandboxInstance {
  return {
    sandboxId: id,
    sandboxEgressId: `${id}-egress`,
    fs: {
      readFile: vi.fn(async () => ""),
      writeFile: vi.fn(async () => {}),
      readdir: vi.fn(async () => []),
      stat: vi.fn(async () => ({ isDirectory: () => false })),
    },
    extendTimeout: vi.fn(async () => {}),
    mkDir: vi.fn(async () => {}),
    readFileToBuffer: vi.fn(async () => Buffer.from(id)),
    runCommand: vi.fn(async () => ({
      exitCode: 0,
      stdout: async () => id,
      stderr: async () => "",
    })),
    snapshot: vi.fn(async () => ({ snapshotId: `${id}-snapshot` })),
    stop: vi.fn(async () => undefined),
    update: vi.fn(async () => {}),
    writeFiles: vi.fn(async () => {}),
  };
}

describe("createLazySandboxWorkspace", () => {
  it("boots the sandbox once for repeated workspace calls", async () => {
    let activeSandboxId: string | undefined;
    const createSandboxMock = vi.fn(async () => {
      activeSandboxId = "sandbox-1";
      return createSandbox("sandbox-1");
    });
    const workspace = createLazySandboxWorkspace({
      executor: {
        createSandbox: createSandboxMock,
        getSandboxId: () => activeSandboxId,
      },
      logContext: {},
    });

    await expect(
      workspace.readFileToBuffer({ path: "report.txt" }),
    ).resolves.toEqual(Buffer.from("sandbox-1"));
    const command = await workspace.runCommand({ cmd: "pwd" });

    await expect(command.stdout()).resolves.toBe("sandbox-1");
    expect(createSandboxMock).toHaveBeenCalledTimes(1);
  });

  it("reuses an in-flight boot across concurrent workspace calls", async () => {
    let activeSandboxId: string | undefined;
    let releaseBoot!: () => void;
    const createSandboxMock = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseBoot = resolve;
      });
      activeSandboxId = "sandbox-1";
      return createSandbox("sandbox-1");
    });
    const workspace = createLazySandboxWorkspace({
      executor: {
        createSandbox: createSandboxMock,
        getSandboxId: () => activeSandboxId,
      },
      logContext: {},
    });

    const read = workspace.readFileToBuffer({ path: "report.txt" });
    const command = workspace.runCommand({ cmd: "pwd" });
    releaseBoot();

    await expect(read).resolves.toEqual(Buffer.from("sandbox-1"));
    await expect((await command).stdout()).resolves.toBe("sandbox-1");
    expect(createSandboxMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes the cached workspace when the executor has a replacement sandbox", async () => {
    let nextSandboxVersion = 1;
    let activeSandboxId: string | undefined;
    const createSandboxMock = vi.fn(async () => {
      const sandboxId = `sandbox-${nextSandboxVersion}`;
      activeSandboxId = sandboxId;
      return createSandbox(sandboxId);
    });
    const workspace = createLazySandboxWorkspace({
      executor: {
        createSandbox: createSandboxMock,
        getSandboxId: () => activeSandboxId,
      },
      logContext: {},
    });

    await expect(
      workspace.readFileToBuffer({ path: "report.txt" }),
    ).resolves.toEqual(Buffer.from("sandbox-1"));
    nextSandboxVersion = 2;
    activeSandboxId = "sandbox-2";

    await expect(
      workspace.readFileToBuffer({ path: "report.txt" }),
    ).resolves.toEqual(Buffer.from("sandbox-2"));
    expect(createSandboxMock).toHaveBeenCalledTimes(2);
  });

  it("retries sandbox boot after a failed boot attempt", async () => {
    let activeSandboxId: string | undefined;
    const createSandboxMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("boot failed"))
      .mockImplementationOnce(async () => {
        activeSandboxId = "sandbox-1";
        return createSandbox("sandbox-1");
      });
    const workspace = createLazySandboxWorkspace({
      executor: {
        createSandbox: createSandboxMock,
        getSandboxId: () => activeSandboxId,
      },
      logContext: {},
    });

    await expect(
      workspace.readFileToBuffer({ path: "report.txt" }),
    ).rejects.toThrow("boot failed");
    await expect(
      workspace.readFileToBuffer({ path: "report.txt" }),
    ).resolves.toEqual(Buffer.from("sandbox-1"));
    expect(createSandboxMock).toHaveBeenCalledTimes(2);
  });
});
