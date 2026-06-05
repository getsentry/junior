import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupRuntimeDependencySnapshotTest,
  getPluginRuntimeDependenciesMock,
  getPluginRuntimePostinstallMock,
  getRuntimeDependencyScript,
  makeRuntimeDependencySandbox,
  resolveRuntimeDependencySnapshot,
  sandboxCreateMock,
  setupRuntimeDependencySnapshotTest,
} from "../../fixtures/runtime-dependency-snapshots";

describe("runtime dependency snapshot install", () => {
  beforeEach(setupRuntimeDependencySnapshotTest);
  afterEach(cleanupRuntimeDependencySnapshotTest);

  it("stops the build sandbox after snapshot creation succeeds", async () => {
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" },
    ]);
    const sandbox = makeRuntimeDependencySandbox("snap_stopped");
    sandboxCreateMock.mockResolvedValueOnce(sandbox);

    const snapshot = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(snapshot.snapshotId).toBe("snap_stopped");
    expect(sandbox.stop).toHaveBeenCalledTimes(1);
  });

  it("passes token-based Vercel Sandbox credentials to snapshot builds", async () => {
    process.env.VERCEL_TOKEN = "sandbox-token";
    process.env.VERCEL_TEAM_ID = "team_123";
    process.env.VERCEL_PROJECT_ID = "prj_123";
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "1.0.0" },
    ]);
    const sandbox = makeRuntimeDependencySandbox("snap_creds");
    sandboxCreateMock.mockResolvedValueOnce(sandbox);

    const snapshot = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });

    expect(snapshot.snapshotId).toBe("snap_creds");
    expect(sandboxCreateMock).toHaveBeenCalledWith({
      timeout: 60_000,
      runtime: "node22",
      token: "sandbox-token",
      teamId: "team_123",
      projectId: "prj_123",
    });
  });

  it("installs system dependencies via dnf", async () => {
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "system", package: "gh" },
    ]);
    const sandbox = makeRuntimeDependencySandbox("snap_system");
    sandboxCreateMock.mockResolvedValueOnce(sandbox);

    const snapshot = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(snapshot.snapshotId).toBe("snap_system");
    const invocation = sandbox.runCommand.mock.calls[0]?.[0];
    expect(invocation).toMatchObject({ cmd: "bash", sudo: true });
    expect(getRuntimeDependencyScript(invocation)).toContain("exec </dev/null");
    expect(getRuntimeDependencyScript(invocation)).toContain(
      "'dnf' 'install' '-y' 'gh'",
    );
  });

  it("installs system dependencies from URL after sha256 verification", async () => {
    getPluginRuntimeDependenciesMock.mockReturnValue([
      {
        type: "system",
        url: "https://example.com/tool.rpm",
        sha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ]);
    const sandbox = makeRuntimeDependencySandbox(
      "snap_system_url",
      async (params) => {
        if (getRuntimeDependencyScript(params).includes("'sha256sum'")) {
          return {
            exitCode: 0,
            stdout: async () =>
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  /tmp/junior-runtime-dep.rpm",
            stderr: async () => "",
          };
        }
        return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
      },
    );
    sandboxCreateMock.mockResolvedValueOnce(sandbox);

    const snapshot = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(snapshot.snapshotId).toBe("snap_system_url");
    const scripts = sandbox.runCommand.mock.calls.map((call) =>
      getRuntimeDependencyScript(call[0]),
    );
    expect(scripts).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "'curl' '-fsSL' 'https://example.com/tool.rpm' '-o' '/tmp/junior-runtime-aaaaaaaaaaaa-tool.rpm'",
        ),
        expect.stringContaining(
          "'sha256sum' '/tmp/junior-runtime-aaaaaaaaaaaa-tool.rpm'",
        ),
        expect.stringContaining(
          "'dnf' 'install' '-y' '/tmp/junior-runtime-aaaaaaaaaaaa-tool.rpm'",
        ),
      ]),
    );
  });

  it("falls back to gh-cli repo bootstrap when dnf cannot resolve gh directly", async () => {
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "system", package: "gh" },
    ]);
    const sandbox = makeRuntimeDependencySandbox(
      "snap_system_fallback",
      async (params) => {
        const script = getRuntimeDependencyScript(params);
        if (!script.includes("'dnf'")) {
          return {
            exitCode: 1,
            stdout: async () => "",
            stderr: async () => "unsupported command",
          };
        }

        if (
          script.includes("'dnf' 'install' '-y' 'gh'") &&
          !script.includes("'--repo' 'gh-cli'")
        ) {
          return {
            exitCode: 1,
            stdout: async () => "",
            stderr: async () => "Unable to find a match: gh",
          };
        }

        return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
      },
    );
    sandboxCreateMock.mockResolvedValueOnce(sandbox);

    const snapshot = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(snapshot.snapshotId).toBe("snap_system_fallback");
    const scripts = sandbox.runCommand.mock.calls.map((call) =>
      getRuntimeDependencyScript(call[0]),
    );
    expect(scripts).toEqual(
      expect.arrayContaining([
        expect.stringContaining("'dnf' 'install' '-y' 'gh'"),
        expect.stringContaining(
          "'dnf' 'config-manager' 'addrepo' '--from-repofile=https://cli.github.com/packages/rpm/gh-cli.repo'",
        ),
        expect.stringContaining("'dnf' 'install' '-y' 'gh' '--repo' 'gh-cli'"),
      ]),
    );
  });

  it("runs runtime-postinstall commands after dependency install", async () => {
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "example-cli", version: "latest" },
    ]);
    getPluginRuntimePostinstallMock.mockReturnValue([
      { cmd: "example-cli", args: ["install"] },
    ]);
    const sandbox = makeRuntimeDependencySandbox("snap_postinstall");
    sandboxCreateMock.mockResolvedValueOnce(sandbox);

    const snapshot = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(snapshot.snapshotId).toBe("snap_postinstall");
    const npmInvocation = sandbox.runCommand.mock.calls[0]?.[0];
    expect(npmInvocation).toMatchObject({
      cmd: "bash",
    });
    expect(npmInvocation.args?.[1]).toContain("exec </dev/null");
    expect(npmInvocation.args?.[1]).toContain(
      "'npm' 'install' '--global' '--prefix' '/vercel/sandbox/.junior' 'example-cli@latest'",
    );

    const postinstallInvocation = sandbox.runCommand.mock.calls[1]?.[0];
    expect(postinstallInvocation).toMatchObject({
      cmd: "bash",
    });
    expect(postinstallInvocation.args?.[1]).toContain(
      'export PATH="/vercel/sandbox/.junior/bin:$PATH"',
    );
    expect(postinstallInvocation.args?.[1]).toContain("exec </dev/null");
    expect(postinstallInvocation.args?.[1]).toContain(
      "'example-cli' 'install'",
    );
  });
});
