import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setSandboxEgressAuthRequiredSignal,
  setSandboxEgressPermissionDeniedSignal,
} from "@/chat/sandbox/egress-session";
import {
  createSandboxExecutor,
  createSandboxSessionManager,
  createStreamInterruptedError,
  credentialTokenFromForwardURL,
  makeSandbox,
  parseSandboxEgressCredentialToken,
  sandboxGetMock,
  sentryForwardURLFromPolicy,
  setupSandboxExecutorTest,
  cleanupSandboxExecutorTest,
} from "../../fixtures/sandbox-executor";
import { mockTestClock } from "../../fixtures/vitest";

describe("sandbox executor bash execution", () => {
  beforeEach(setupSandboxExecutorTest);

  afterEach(cleanupSandboxExecutorTest);

  it("runs bash commands through a noninteractive shell", async () => {
    const sandbox = makeSandbox("sbx_bash");
    sandboxGetMock.mockResolvedValue(sandbox);

    const executor = createSandboxExecutor({ sandboxId: "sbx_bash" });
    executor.configureSkills([]);

    await executor.execute({
      toolName: "bash",
      input: {
        command: "echo ok",
      },
    });

    const invocation = sandbox.runCommand.mock.calls[0]?.[0];
    expect(invocation).toMatchObject({
      cmd: "bash",
      cwd: "/vercel/sandbox",
    });
    expect(invocation.args?.[0]).toBe("-c");
    expect(invocation.args?.[1]).toContain(
      'export PATH="/vercel/sandbox/.junior/bin:$PATH"',
    );
    expect(invocation.args?.[1]).toContain("export CI='1'");
    expect(invocation.args?.[1]).toContain("export TERM='dumb'");
    expect(invocation.args?.[1]).toContain("export GH_PROMPT_DISABLED='1'");
    expect(invocation.args?.[1]).toContain("export GIT_TERMINAL_PROMPT='0'");
    expect(invocation.args?.[1]).toContain("exec </dev/null");
    expect(invocation.args?.[1]).toContain("echo ok");
  });

  it("applies a host timeout to bash commands when the model omits one", async () => {
    mockTestClock();
    const sandbox = makeSandbox("sbx_bash_timeout");
    sandbox.runCommand.mockImplementationOnce(
      async (input) =>
        await new Promise((_, reject) => {
          input.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    sandboxGetMock.mockResolvedValue(sandbox);

    const executor = createSandboxExecutor({ sandboxId: "sbx_bash_timeout" });
    executor.configureSkills([]);

    const responsePromise = executor.execute({
      toolName: "bash",
      input: {
        command: "sleep 999",
      },
    });

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    const response = await responsePromise;

    expect(response.result).toMatchObject({
      ok: false,
      exit_code: 124,
      timed_out: true,
      stderr: "Command timed out after 300000ms",
    });
  });

  it("aborts bash commands when the agent turn is cancelled", async () => {
    const sandbox = makeSandbox("sbx_bash_abort");
    sandbox.runCommand.mockImplementationOnce(
      async (input) =>
        await new Promise((_, reject) => {
          input.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    sandboxGetMock.mockResolvedValue(sandbox);

    const executor = createSandboxExecutor({ sandboxId: "sbx_bash_abort" });
    executor.configureSkills([]);
    const abortController = new AbortController();

    const responsePromise = executor.execute({
      toolName: "bash",
      input: {
        command: "sleep 999",
      },
      signal: abortController.signal,
    });

    await Promise.resolve();
    abortController.abort();
    const response = await responsePromise;

    expect(response.result).toMatchObject({
      ok: false,
      exit_code: 130,
      timed_out: false,
      stderr: "Command aborted because the agent turn was cancelled.",
    });
  });

  it("resolves sandbox command environment for each bash command", async () => {
    const sandbox = makeSandbox("sbx_dynamic_env");
    sandboxGetMock.mockResolvedValue(sandbox);
    const commandEnv = vi
      .fn<() => Promise<Record<string, string>>>()
      .mockResolvedValueOnce({
        GIT_AUTHOR_NAME: "first-bot",
      })
      .mockResolvedValueOnce({
        GIT_AUTHOR_NAME: "second-bot",
      });

    const manager = createSandboxSessionManager({
      sandboxId: "sbx_dynamic_env",
      commandEnv,
    });
    const bash = (await manager.ensureToolExecutors()).bash;

    await bash({ command: "git commit --allow-empty -m first" });
    await bash({ command: "git commit --allow-empty -m second" });

    expect(commandEnv).toHaveBeenCalledTimes(2);
    expect(sandbox.runCommand.mock.calls[0]?.[0].args?.[1]).toContain(
      "export GIT_AUTHOR_NAME='first-bot'",
    );
    expect(sandbox.runCommand.mock.calls[1]?.[0].args?.[1]).toContain(
      "export GIT_AUTHOR_NAME='second-bot'",
    );
  });

  it("configures lazy user actor auth for sandbox egress", async () => {
    const sandbox = makeSandbox("sbx_authorize_credentials");
    sandbox.runCommand.mockImplementationOnce(async () => {
      const activePolicy = sandbox.update.mock.calls.at(-1)?.[0].networkPolicy;
      const activeCredentialToken = credentialTokenFromForwardURL(
        sentryForwardURLFromPolicy(activePolicy),
      );

      expect(
        parseSandboxEgressCredentialToken(activeCredentialToken),
      ).toMatchObject({
        credentials: { actor: { type: "user", userId: "U123" } },
        egressId: "sbx_authorize_credentials_session",
      });
      return {
        exitCode: 0,
        stdout: async () => "",
        stderr: async () => "",
      };
    });
    sandboxGetMock.mockResolvedValue(sandbox);

    const executor = createSandboxExecutor({
      sandboxId: "sbx_authorize_credentials",
      credentialEgress: {
        actor: { type: "user", userId: "U123" },
      },
    });
    executor.configureSkills([]);

    await executor.execute({
      toolName: "bash",
      input: {
        command: "sentry-cli issues list",
      },
    });

    expect(sandbox.update).toHaveBeenCalledTimes(1);
    expect(
      credentialTokenFromForwardURL(
        sentryForwardURLFromPolicy(
          sandbox.update.mock.calls[0]?.[0].networkPolicy,
        ),
      ),
    ).toBeTruthy();
    const invocation = sandbox.runCommand.mock.calls[0]?.[0];
    expect(invocation.args?.[1]).toContain(
      "export SENTRY_AUTH_TOKEN='host_managed_credential'",
    );
    expect(invocation.args?.[1]).toContain("sentry-cli issues list");
  });

  it("clears stale sandbox egress signals before running bash commands", async () => {
    const sandbox = makeSandbox("sbx_stale_auth_signal");
    sandbox.runCommand.mockImplementationOnce(async () => ({
      exitCode: 1,
      stdout: async () => "",
      stderr: async () => "command-controlled output",
    }));
    sandboxGetMock.mockResolvedValue(sandbox);
    await setSandboxEgressAuthRequiredSignal(
      {
        credentials: { actor: { type: "user", userId: "U123" } },
        egressId: "sbx_stale_auth_signal_session",
        expiresAtMs: Date.now() + 60_000,
        contextId: "ctx-stale",
      },
      {
        provider: "github",
        grant: {
          name: "user-write",
          access: "write",
        },
      },
    );
    await setSandboxEgressPermissionDeniedSignal(
      {
        credentials: { actor: { type: "user", userId: "U123" } },
        egressId: "sbx_stale_auth_signal_session",
        expiresAtMs: Date.now() + 60_000,
        contextId: "ctx-stale-permission",
      },
      {
        provider: "github",
        grant: {
          name: "user-write",
          access: "write",
        },
        message:
          "github returned HTTP 403 after Junior injected the user-write grant. Junior forwarded the request; this is not a local runtime block.",
        source: "upstream",
        status: 403,
        upstreamHost: "github.com",
        upstreamPath: "/getsentry/junior.git/info/refs",
      },
    );

    const executor = createSandboxExecutor({
      sandboxId: "sbx_stale_auth_signal",
    });
    executor.configureSkills([]);

    const response = await executor.execute<{
      auth_required?: unknown;
      exit_code: number;
      permission_denied?: unknown;
    }>({
      toolName: "bash",
      input: {
        command: "printf stale",
      },
    });

    expect(response.result.exit_code).toBe(1);
    expect(response.result.auth_required).toBeUndefined();
    expect(response.result.permission_denied).toBeUndefined();
  });

  it("attaches sandbox egress auth signals to failed bash results", async () => {
    const sandbox = makeSandbox("sbx_fresh_auth_signal");
    sandbox.runCommand.mockImplementationOnce(async () => {
      await setSandboxEgressAuthRequiredSignal(
        {
          credentials: { actor: { type: "user", userId: "U123" } },
          egressId: "sbx_fresh_auth_signal_session",
          expiresAtMs: Date.now() + 60_000,
          contextId: "ctx-fresh",
        },
        {
          provider: "github",
          grant: {
            name: "user-write",
            access: "write",
          },
        },
      );
      return {
        exitCode: 1,
        stdout: async () => "",
        stderr: async () =>
          "junior-auth-required provider=github grant=user-write access=write 401 unauthorized",
      };
    });
    sandboxGetMock.mockResolvedValue(sandbox);

    const executor = createSandboxExecutor({
      sandboxId: "sbx_fresh_auth_signal",
    });
    executor.configureSkills([]);

    const response = await executor.execute<{
      auth_required?: unknown;
      exit_code: number;
    }>({
      toolName: "bash",
      input: {
        command: "gh issue create",
      },
    });

    expect(response.result.exit_code).toBe(1);
    expect(response.result.auth_required).toMatchObject({
      provider: "github",
      grant: {
        name: "user-write",
        access: "write",
      },
    });
  });

  it("attaches sandbox egress permission signals to failed bash results", async () => {
    const sandbox = makeSandbox("sbx_permission_signal");
    sandbox.runCommand.mockImplementationOnce(async () => {
      await setSandboxEgressPermissionDeniedSignal(
        {
          credentials: { actor: { type: "user", userId: "U123" } },
          egressId: "sbx_permission_signal_session",
          expiresAtMs: Date.now() + 60_000,
          contextId: "ctx-permission",
        },
        {
          provider: "github",
          grant: {
            name: "user-write",
            access: "write",
            reason: "github.git-write",
          },
          message:
            "github returned HTTP 403 after Junior injected the user-write grant. Junior forwarded the request; this is not a local runtime block.",
          source: "upstream",
          status: 403,
          upstreamHost: "github.com",
          upstreamPath: "/getsentry/junior.git/info/refs",
          acceptedPermissions: "contents=write",
        },
      );
      return {
        exitCode: 1,
        stdout: async () => "",
        stderr: async () => "remote: Permission denied",
      };
    });
    sandboxGetMock.mockResolvedValue(sandbox);

    const executor = createSandboxExecutor({
      sandboxId: "sbx_permission_signal",
    });
    executor.configureSkills([]);

    const response = await executor.execute<{
      exit_code: number;
      permission_denied?: unknown;
    }>({
      toolName: "bash",
      input: {
        command: "git push",
      },
    });

    expect(response.result.exit_code).toBe(1);
    expect(response.result.permission_denied).toMatchObject({
      provider: "github",
      grant: {
        name: "user-write",
        access: "write",
        reason: "github.git-write",
      },
      message:
        "github returned HTTP 403 after Junior injected the user-write grant. Junior forwarded the request; this is not a local runtime block.",
      source: "upstream",
      status: 403,
      upstreamHost: "github.com",
      upstreamPath: "/getsentry/junior.git/info/refs",
      acceptedPermissions: "contents=write",
    });
  });

  it("prefers write sandbox egress auth signals over read signals", async () => {
    const sandbox = makeSandbox("sbx_mixed_auth_signal");
    sandbox.runCommand.mockImplementationOnce(async () => {
      const context = {
        credentials: { actor: { type: "user" as const, userId: "U123" } },
        egressId: "sbx_mixed_auth_signal_session",
        expiresAtMs: Date.now() + 60_000,
        contextId: "ctx-mixed",
      };
      await setSandboxEgressAuthRequiredSignal(context, {
        provider: "github",
        grant: {
          name: "user-write",
          access: "write",
        },
      });
      await setSandboxEgressAuthRequiredSignal(context, {
        provider: "github",
        grant: {
          name: "installation-read",
          access: "read",
        },
      });
      return {
        exitCode: 1,
        stdout: async () => "",
        stderr: async () =>
          "junior-auth-required provider=github grant=user-write access=write 401 unauthorized",
      };
    });
    sandboxGetMock.mockResolvedValue(sandbox);

    const executor = createSandboxExecutor({
      sandboxId: "sbx_mixed_auth_signal",
    });
    executor.configureSkills([]);

    const response = await executor.execute<{
      auth_required?: unknown;
      exit_code: number;
    }>({
      toolName: "bash",
      input: {
        command: "gh issue create",
      },
    });

    expect(response.result.exit_code).toBe(1);
    expect(response.result.auth_required).toMatchObject({
      provider: "github",
      grant: {
        name: "user-write",
        access: "write",
      },
    });
  });

  it("configures lazy system actor credential context for sandbox egress", async () => {
    const sandbox = makeSandbox("sbx_authorize_system_credentials");
    sandbox.runCommand.mockImplementationOnce(async () => {
      const activePolicy = sandbox.update.mock.calls.at(-1)?.[0].networkPolicy;
      const activeCredentialToken = credentialTokenFromForwardURL(
        sentryForwardURLFromPolicy(activePolicy),
      );

      expect(
        parseSandboxEgressCredentialToken(activeCredentialToken),
      ).toMatchObject({
        credentials: { actor: { type: "system", id: "scheduler" } },
        egressId: "sbx_authorize_system_credentials_session",
      });
      return {
        exitCode: 0,
        stdout: async () => "",
        stderr: async () => "",
      };
    });
    sandboxGetMock.mockResolvedValue(sandbox);

    const executor = createSandboxExecutor({
      sandboxId: "sbx_authorize_system_credentials",
      credentialEgress: {
        actor: { type: "system", id: "scheduler" },
      },
    });
    executor.configureSkills([]);

    await executor.execute({
      toolName: "bash",
      input: {
        command: "sentry-cli issues list",
      },
    });

    expect(sandbox.update).toHaveBeenCalledTimes(1);
    const invocation = sandbox.runCommand.mock.calls[0]?.[0];
    expect(invocation.args?.[1]).toContain(
      "export SENTRY_AUTH_TOKEN='host_managed_credential'",
    );
    expect(invocation.args?.[1]).toContain("sentry-cli issues list");
  });

  it("makes registered provider placeholders available to sandbox commands", async () => {
    const sandbox = makeSandbox("sbx_registered_credentials");
    sandboxGetMock.mockResolvedValue(sandbox);

    const executor = createSandboxExecutor({
      sandboxId: "sbx_registered_credentials",
      credentialEgress: {
        actor: { type: "user", userId: "U123" },
      },
    });
    executor.configureSkills([]);

    await executor.execute({
      toolName: "bash",
      input: {
        command: "echo local-only",
      },
    });

    expect(sandbox.update).toHaveBeenCalledTimes(1);
    expect(
      credentialTokenFromForwardURL(
        sentryForwardURLFromPolicy(
          sandbox.update.mock.calls[0]?.[0].networkPolicy,
        ),
      ),
    ).toBeTruthy();
    const invocation = sandbox.runCommand.mock.calls[0]?.[0];
    expect(invocation.args?.[1]).toContain(
      "export SENTRY_AUTH_TOKEN='host_managed_credential'",
    );
    expect(invocation.args?.[1]).toContain("echo local-only");
  });

  it("returns a failed bash result when the command stream ends without a status", async () => {
    const streamError = createStreamInterruptedError();
    const sandbox = makeSandbox("sbx_stream_interrupted");
    sandbox.runCommand.mockRejectedValueOnce(streamError);
    sandboxGetMock.mockResolvedValue(sandbox);

    const executor = createSandboxExecutor({
      sandboxId: "sbx_stream_interrupted",
    });
    executor.configureSkills([]);

    const response = await executor.execute({
      toolName: "bash",
      input: {
        command: "pnpm test",
      },
    });

    expect(response.result).toMatchObject({
      ok: false,
      exit_code: 125,
      stderr:
        "Command stream ended before the command finished. The command may still have produced side effects; inspect the workspace or rerun only if it is safe.",
    });
  });
});
