import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_WORKSPACE_ROOT, sandboxSkillDir } from "@/chat/sandbox/paths";
import type { SandboxSession } from "@/chat/sandbox/workspace";
import type { SkillMetadata } from "@/chat/skills";

type StructuredSandboxResult = {
  details: Record<string, unknown>;
};

const { sandboxGetMock, sandboxCreateMock } = vi.hoisted(() => ({
  sandboxGetMock: vi.fn(),
  sandboxCreateMock: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  FileSystem: class {
    private readonly fs: {
      readFile(
        filePath: string,
        options: { encoding: BufferEncoding; signal?: AbortSignal },
      ): Promise<string>;
      writeFile(
        filePath: string,
        content: string,
        options?: { encoding?: BufferEncoding; signal?: AbortSignal },
      ): Promise<void>;
      readdir(
        filePath: string,
        options?: { signal?: AbortSignal },
      ): Promise<string[]>;
      stat(
        filePath: string,
        options?: { signal?: AbortSignal },
      ): Promise<{ isDirectory(): boolean }>;
    };

    constructor(session: { fs: MockSandbox["fs"] }) {
      this.fs = (session.fs as typeof this.fs);
    }

    readFile(
      filePath: string,
      options: { encoding: BufferEncoding; signal?: AbortSignal },
    ) {
      return this.fs.readFile(filePath, options);
    }

    writeFile(
      filePath: string,
      content: string,
      options?: { encoding?: BufferEncoding; signal?: AbortSignal },
    ) {
      return this.fs.writeFile(filePath, content, options);
    }

    readdir(filePath: string, options?: { signal?: AbortSignal }) {
      return this.fs.readdir(filePath, options);
    }

    stat(filePath: string, options?: { signal?: AbortSignal }) {
      return this.fs.stat(filePath, options);
    }
  },
  Sandbox: {
    get: sandboxGetMock,
    create: sandboxCreateMock,
  },
}));

vi.mock("@/chat/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/chat/config")>();
  const memoryConfig = original.readChatConfig({
    ...process.env,
    JUNIOR_STATE_ADAPTER: "memory",
  });
  return {
    ...original,
    botConfig: memoryConfig.bot,
    getChatConfig: () => memoryConfig,
  };
});
vi.mock("@/chat/plugins/catalog-runtime", () => ({
  pluginCatalogRuntime: {
    getProviders: () => [
      {
        manifest: {
          name: "sentry",
          displayName: "Sentry",
          description: "Sentry",
          configKeys: [],
          commandEnv: {
            SENTRY_READ_ONLY: "1",
          },
          credentials: {
            type: "oauth-bearer",
            domains: ["sentry.io"],
            authTokenEnv: "SENTRY_AUTH_TOKEN",
            authTokenPlaceholder: "host_managed_credential",
          },
        },
      },
    ],
  },
}));

const {
  resolveMock,
  ensureWorkspaceSnapshotBuildMock,
  getReadyWorkspaceMock,
  missingErrorMock,
  hashMock,
} = vi.hoisted(() => ({
    resolveMock: vi.fn<
      (...args: any[]) => Promise<{
        snapshotId?: string;
        profileHash?: string;
        dependencyCount: number;
        cacheHit: boolean;
        resolveOutcome: string;
        rebuildReason?: string;
      }>
    >(async () => ({
      dependencyCount: 0,
      cacheHit: false,
      resolveOutcome: "no_profile",
    })),
    ensureWorkspaceSnapshotBuildMock: vi.fn(async () => "building" as const),
    getReadyWorkspaceMock: vi.fn<
      (...args: any[]) => Promise<{
        snapshotId?: string;
        profileHash?: string;
        dependencyCount: number;
        cacheHit: boolean;
        resolveOutcome: string;
      }>
    >(async () => ({
      dependencyCount: 0,
      cacheHit: false,
      resolveOutcome: "no_profile",
    })),
    missingErrorMock: vi.fn<(error: unknown) => boolean>(() => false),
    hashMock: vi.fn<(runtime: string) => string | undefined>(() => undefined),
  }));

vi.mock("@/chat/sandbox/snapshot/job-runner", () => ({
  ensureWorkspaceSnapshotBuild: ensureWorkspaceSnapshotBuildMock,
}));
vi.mock("@/chat/sandbox/snapshot/profile", () => ({
  hash: hashMock,
}));

vi.mock("@/chat/sandbox/snapshot/resolve", () => ({
  resolve: resolveMock,
  isMissingError: missingErrorMock,
}));
vi.mock("@/chat/sandbox/snapshot/workspace", () => ({
  requireReadyWorkspaceSnapshot: getReadyWorkspaceMock,
}));

vi.mock("@/chat/sandbox/docker", () => ({
  ensureDockerDaemon: vi.fn(async () => {}),
}));

import { createSandbox } from "@/chat/sandbox/sandbox";
import {
  parseSandboxEgressCredentialToken,
  SANDBOX_EGRESS_PROXY_PATH,
  setSandboxEgressAuthRequiredSignal,
  setSandboxEgressPermissionDeniedSignal,
} from "@/chat/sandbox/egress/session";
import { createSandboxRuntime } from "@/chat/sandbox/session";
import {
  isWorkspaceSnapshotNotReadyError,
  WorkspaceSnapshotNotReadyError,
} from "@/chat/sandbox/snapshot/not-ready-error";
import { createSandboxSession } from "@/chat/sandbox/workspace";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
interface SandboxFixtureOptions {
  sandboxId?: string;
  sandboxDependencyProfileHash?: string;
  timeoutMs?: number;
  traceContext?: Record<string, unknown>;
  tracePropagation?: any;
  credentialEgress?: any;
  agentHooks?: {
    beforeToolExecute: ReturnType<typeof vi.fn>;
    prepareSandbox(workspace: SandboxWorkspace): Promise<void>;
  };
  onSandboxPrepare?: (sandbox: SandboxSession) => void | Promise<void>;
  onSandboxAcquired?: (sandbox: {
    sandboxId: string;
    sandboxDependencyProfileHash?: string;
  }) => void | Promise<void>;
  createNetworkPolicy?: (...args: any[]) => any;
  commandEnv?: () => Promise<Record<string, string>>;
}

function createTestSandboxRuntime(options: SandboxFixtureOptions = {}) {
  let skills: SkillMetadata[] = [];
  let referenceFiles: string[] = [];
  let runtime: ReturnType<typeof createSandboxRuntime> | undefined;
  const getRuntime = () =>
    (runtime ??= createSandboxRuntime({
      sandboxRef: options.sandboxId
        ? {
            id: options.sandboxId,
            ...(options.sandboxDependencyProfileHash
              ? { profileHash: options.sandboxDependencyProfileHash }
              : undefined),
          }
        : undefined,
      skills,
      referenceFiles,
      timeoutMs: options.timeoutMs,
      traceContext: options.traceContext,
      commandEnv: options.commandEnv,
      createNetworkPolicy: options.createNetworkPolicy,
      onSandboxPrepare: options.onSandboxPrepare,
      onSandboxRefChanged: async (ref) => {
        await options.onSandboxAcquired?.({
          sandboxId: ref.id,
          ...(ref.profileHash
            ? { sandboxDependencyProfileHash: ref.profileHash }
            : undefined),
        });
      },
    }));
  return {
    configureSkills(nextSkills: SkillMetadata[]) {
      skills = [...nextSkills];
    },
    configureReferenceFiles(nextFiles: string[]) {
      referenceFiles = [...nextFiles];
    },
    getSandboxId: () => getRuntime().sandboxRef()?.id,
    getDependencyProfileHash: () => getRuntime().sandboxRef()?.profileHash,
    createSandbox: async () => await getRuntime().acquire(),
    ensureToolExecutors: async () => await getRuntime().tools(),
    refreshNetworkPolicy: async (
      ...args: Parameters<
        ReturnType<typeof createSandboxRuntime>["refreshNetworkPolicy"]
      >
    ) => await getRuntime().refreshNetworkPolicy(...args),
    close: () => getRuntime().close(),
  };
}

function createTestSandbox(options: SandboxFixtureOptions = {}) {
  let skills: SkillMetadata[] = [];
  let referenceFiles: string[] = [];
  let access: ReturnType<typeof createSandbox> | undefined;
  const getAccess = () =>
    (access ??= createSandbox({
      sandboxRef: options.sandboxId
        ? {
            id: options.sandboxId,
            ...(options.sandboxDependencyProfileHash
              ? { profileHash: options.sandboxDependencyProfileHash }
              : undefined),
          }
        : undefined,
      skills,
      referenceFiles,
      timeoutMs: options.timeoutMs,
      traceContext: options.traceContext,
      tracePropagation: options.tracePropagation,
      credentialEgress: options.credentialEgress,
      prepare: options.agentHooks
        ? async (workspace) =>
            await options.agentHooks?.prepareSandbox(workspace)
        : undefined,
      onSandboxRefChanged: async (ref) => {
        await options.onSandboxAcquired?.({
          sandboxId: ref.id,
          ...(ref.profileHash
            ? { sandboxDependencyProfileHash: ref.profileHash }
            : undefined),
        });
      },
    }));
  return {
    configureSkills(nextSkills: SkillMetadata[]) {
      skills = [...nextSkills];
    },
    configureReferenceFiles(nextFiles: string[]) {
      referenceFiles = [...nextFiles];
    },
    getSandboxId: () => getAccess().sandboxRef()?.id,
    getDependencyProfileHash: () => getAccess().sandboxRef()?.profileHash,
    canExecute: (toolName: string) => getAccess().tools.supports(toolName),
    createSandbox: async () => {
      const sandbox = getAccess();
      await sandbox.workspace.writeFiles([]);
      return sandbox.workspace;
    },
    execute: async <T>(params: {
      toolName: string;
      input: unknown;
      signal?: AbortSignal;
    }): Promise<{ result: T }> => {
      return { result: (await getAccess().tools.execute(params)) as T };
    },
  };
}

interface MockSandbox {
  name: string;
  session: {
    sessionId: string;
    fs: MockSandbox["fs"];
    mkDir: MockSandbox["mkDir"];
    writeFiles: MockSandbox["writeFiles"];
    readFileToBuffer: MockSandbox["readFileToBuffer"];
    runCommand: MockSandbox["runCommand"];
    stop: MockSandbox["stop"];
    extendTimeout: MockSandbox["extendTimeout"];
    snapshot: MockSandbox["snapshot"];
    update: MockSandbox["update"];
  };
  currentSession: ReturnType<typeof vi.fn>;
  fs: {
    readFile: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
    readdir: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
  };
  mkDir: ReturnType<typeof vi.fn>;
  writeFiles: ReturnType<typeof vi.fn>;
  readFileToBuffer: ReturnType<typeof vi.fn>;
  runCommand: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  extendTimeout: ReturnType<typeof vi.fn>;
  snapshot: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

function makeSandbox(
  name: string,
  options: {
    mkDirError?: unknown;
    writeFilesError?: unknown;
  } = {},
): MockSandbox {
  const fs = {
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async () => {}),
    readdir: vi.fn(async () => []),
    stat: vi.fn(async () => ({ isDirectory: () => false })),
  };
  const mkDir = vi.fn(async () => {
    if (options.mkDirError) {
      throw options.mkDirError;
    }
  });
  const writeFiles = vi.fn(async () => {
    if (options.writeFilesError) {
      throw options.writeFilesError;
    }
  });
  const readFileToBuffer = vi.fn(async () => Buffer.from(""));
  const runCommand = vi.fn(async () => ({
    exitCode: 0,
    stdout: async () => "",
    stderr: async () => "",
  }));
  const stop = vi.fn(async () => {});
  const extendTimeout = vi.fn(async () => {});
  const snapshot = vi.fn(async () => ({ snapshotId: "snap_test" }));
  const update = vi.fn(async () => {});
  const session = {
    sessionId: `${name}_session`,
    fs,
    mkDir,
    writeFiles,
    readFileToBuffer,
    runCommand,
    stop,
    extendTimeout,
    snapshot,
    update,
  };

  return {
    name,
    session,
    currentSession: vi.fn(() => session),
    fs,
    mkDir,
    writeFiles,
    readFileToBuffer,
    runCommand,
    stop,
    extendTimeout,
    snapshot,
    update,
  };
}

function sentryForwardURLFromPolicy(policy: unknown): string | undefined {
  const allow = (
    policy as { allow?: Record<string, Array<{ forwardURL?: string }>> }
  ).allow;
  return allow?.["sentry.io"]?.[0]?.forwardURL;
}

function credentialTokenFromForwardURL(
  forwardURL: string | undefined,
): string | undefined {
  if (!forwardURL) {
    return undefined;
  }
  const pathname = new URL(forwardURL).pathname;
  const prefix = `${SANDBOX_EGRESS_PROXY_PATH}/`;
  return pathname.startsWith(prefix)
    ? pathname.slice(prefix.length)
    : undefined;
}

function mockAbortableSandboxCreate(name: string) {
  let releaseFetch: () => void = () => {};
  let requestSignal: AbortSignal | undefined;
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) =>
      await new Promise<Response>((resolve, reject) => {
        requestSignal = init?.signal ?? undefined;
        releaseFetch = () => resolve(new Response());
        const onAbort = () => reject(requestSignal?.reason);
        if (requestSignal?.aborted) {
          onAbort();
          return;
        }
        requestSignal?.addEventListener("abort", onAbort, { once: true });
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  sandboxCreateMock.mockImplementationOnce(
    async (params: { fetch?: typeof globalThis.fetch }) => {
      await params.fetch!("https://api.vercel.test/sandboxes");
      return makeSandbox(name);
    },
  );
  return {
    fetchMock,
    release: () => releaseFetch(),
    signal: () => requestSignal,
  };
}

function createApiError(
  status: number,
  statusText: string,
  code: string,
  message: string,
): Error {
  return Object.assign(new Error(`Status code ${status} is not ok`), {
    response: {
      status,
      statusText,
      url: "https://vercel.com/api/v1/sandboxes/sbx_test/fs/mkdir",
      headers: {
        get: (_name: string) => null,
      },
    },
    json: {
      error: {
        code,
        message,
      },
    },
    sandboxId: "sbx_test",
  });
}

function createStreamInterruptedError(): Error {
  return Object.assign(new Error("Stream ended before command finished"), {
    name: "StreamError",
  });
}

function createClosedStreamError(): Error {
  return Object.assign(
    new Error("Sandbox stream was closed and is not accepting commands."),
    { name: "StreamError" },
  );
}

async function expectWorkspaceToDelegate(
  workspace: SandboxSession | SandboxWorkspace,
  sandbox: MockSandbox,
): Promise<void> {
  const fileBuffer = Buffer.from("workspace file");
  const commandResult = {
    exitCode: 0,
    stdout: async () => "stdout",
    stderr: async () => "stderr",
  };

  sandbox.readFileToBuffer.mockResolvedValueOnce(fileBuffer);
  await expect(
    workspace.readFileToBuffer({ path: "/tmp/workspace.txt" }),
  ).resolves.toBe(fileBuffer);
  expect(sandbox.readFileToBuffer).toHaveBeenCalledWith({
    path: "/tmp/workspace.txt",
  });

  sandbox.runCommand.mockResolvedValueOnce(commandResult);
  const delegatedResult = await workspace.runCommand({
    cmd: "pwd",
    args: ["-P"],
    cwd: "/tmp",
  });
  expect(delegatedResult.exitCode).toBe(commandResult.exitCode);
  expect(delegatedResult.stdout).toBe("stdout");
  expect(delegatedResult.stderr).toBe("stderr");
  expect(sandbox.runCommand).toHaveBeenCalledWith({
    cmd: "pwd",
    args: ["-P"],
    cwd: "/tmp",
  });
}

describe("createTestSandbox", () => {
  beforeEach(() => {
    sandboxGetMock.mockReset();
    sandboxCreateMock.mockReset();
    resolveMock.mockReset();
    resolveMock.mockResolvedValue({
      dependencyCount: 0,
      cacheHit: false,
      resolveOutcome: "no_profile",
    });
    ensureWorkspaceSnapshotBuildMock.mockReset();
    ensureWorkspaceSnapshotBuildMock.mockResolvedValue("building");
    getReadyWorkspaceMock.mockReset();
    getReadyWorkspaceMock.mockResolvedValue({
      dependencyCount: 0,
      cacheHit: false,
      resolveOutcome: "no_profile",
    });
    missingErrorMock.mockReset();
    missingErrorMock.mockReturnValue(false);
    hashMock.mockReset();
    hashMock.mockReturnValue(undefined);
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.VERCEL_SANDBOX_KEEPALIVE_MS;
    delete process.env.SANDBOX_VCPUS;
    process.env.JUNIOR_BASE_URL = "https://junior.example.com";
    process.env.JUNIOR_SECRET = "test-secret";
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await disconnectStateAdapter();
    delete process.env.JUNIOR_BASE_URL;
    delete process.env.JUNIOR_SECRET;
  });

  it("preserves an unopened sandbox reference without rewriting its profile", () => {
    hashMock.mockReturnValue("current-profile");
    const sandbox = createSandbox({
      sandboxRef: { id: "sbx_existing", profileHash: "persisted-profile" },
      skills: [],
      referenceFiles: [],
    });

    expect(sandbox.sandboxRef()).toEqual({
      id: "sbx_existing",
      profileHash: "persisted-profile",
    });
    expect(sandboxGetMock).not.toHaveBeenCalled();
    expect(sandboxCreateMock).not.toHaveBeenCalled();
  });

  it("pins workspace commands to the acquired session without SDK replay", async () => {
    const sandbox = makeSandbox("sbx_pinned_session");
    const resumingRunCommand = vi.fn();
    const workspace = createSandboxSession({
      ...sandbox,
      runCommand: resumingRunCommand,
    } as never);

    await workspace.runCommand({ cmd: "gh", args: ["pr", "create"] });

    expect(sandbox.session.runCommand).toHaveBeenCalledTimes(1);
    expect(resumingRunCommand).not.toHaveBeenCalled();
  });

  it("fails a stopped hinted session and reacquires it on a later call", async () => {
    const stoppedSandbox = makeSandbox("sbx_stopped", {
      mkDirError: createApiError(
        410,
        "Gone",
        "sandbox_stopped",
        "Sandbox has stopped execution and is no longer available",
      ),
    });
    const recoveredSandbox = makeSandbox("sbx_stopped");

    sandboxGetMock
      .mockResolvedValueOnce(stoppedSandbox)
      .mockResolvedValueOnce(recoveredSandbox);

    const executor = createTestSandbox({ sandboxId: "sbx_stopped" });
    executor.configureSkills([]);

    await expect(executor.createSandbox()).rejects.toBeInstanceOf(
      ToolInputError,
    );
    const sandbox = await executor.createSandbox();

    await expectWorkspaceToDelegate(sandbox, recoveredSandbox);
    expect(sandboxGetMock).toHaveBeenCalledWith({
      name: "sbx_stopped",
      resume: true,
    });
    expect(sandboxGetMock).toHaveBeenCalledTimes(2);
    expect(sandboxCreateMock).not.toHaveBeenCalled();
    expect(stoppedSandbox.mkDir).toHaveBeenCalled();
    expect(recoveredSandbox.mkDir).toHaveBeenCalled();
    expect(executor.getSandboxId()).toBe("sbx_stopped");
  });

  it("reports a fresh sandbox reference before session preparation can fail", async () => {
    const unavailable = createClosedStreamError();
    const freshSandbox = makeSandbox("sbx_prepare_failure");
    const callOrder: string[] = [];
    sandboxCreateMock.mockResolvedValue(freshSandbox);

    const executor = createTestSandbox({
      onSandboxAcquired: async () => {
        callOrder.push("reference");
      },
      agentHooks: {
        beforeToolExecute: vi.fn(),
        prepareSandbox: vi.fn(async () => {
          callOrder.push("prepare");
          throw unavailable;
        }),
      },
    });
    executor.configureSkills([]);

    await expect(executor.createSandbox()).rejects.toBeInstanceOf(
      ToolInputError,
    );

    expect(callOrder).toEqual(["reference", "prepare"]);
    expect(executor.getSandboxId()).toBe("sbx_prepare_failure");
    expect(freshSandbox.stop).not.toHaveBeenCalled();
  });

  it("retries durable reference reporting after persistence fails", async () => {
    const freshSandbox = makeSandbox("sbx_ref_retry");
    const replacementSandbox = makeSandbox("sbx_ref_retry_replacement");
    const persistenceError = new Error("state unavailable");
    const onSandboxAcquired = vi
      .fn()
      .mockRejectedValueOnce(persistenceError)
      .mockResolvedValueOnce(undefined);
    sandboxCreateMock
      .mockResolvedValueOnce(freshSandbox)
      .mockResolvedValueOnce(replacementSandbox);

    const executor = createTestSandbox({ onSandboxAcquired });
    executor.configureSkills([]);

    await expect(executor.createSandbox()).rejects.toBe(persistenceError);
    await expect(executor.createSandbox()).resolves.toBeDefined();

    expect(onSandboxAcquired).toHaveBeenCalledTimes(2);
    expect(sandboxCreateMock).toHaveBeenCalledTimes(2);
    expect(sandboxGetMock).not.toHaveBeenCalled();
    expect(freshSandbox.stop).toHaveBeenCalledTimes(1);
  });

  it("shares in-flight sandbox setup across parallel executor initialization", async () => {
    const freshSandbox = makeSandbox("sbx_parallel_boot");
    sandboxCreateMock.mockResolvedValue(freshSandbox);

    let markPrepareStarted: () => void = () => {};
    let releasePrepare: () => void = () => {};
    const prepareStarted = new Promise<void>((resolve) => {
      markPrepareStarted = resolve;
    });
    const prepareReleased = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const onSandboxPrepare = vi.fn(async () => {
      markPrepareStarted();
      await prepareReleased;
    });
    const manager = createTestSandboxRuntime({
      onSandboxPrepare,
    });
    manager.configureSkills([]);

    const first = manager.ensureToolExecutors();
    await prepareStarted;
    const second = manager.ensureToolExecutors();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
    expect(onSandboxPrepare).toHaveBeenCalledTimes(1);

    releasePrepare();
    const [firstExecutors, secondExecutors] = await Promise.all([
      first,
      second,
    ]);

    expect(firstExecutors.fs).toBe(secondExecutors.fs);
  });

  it("cancels sandbox acquisition with the tool signal", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    sandboxCreateMock.mockImplementationOnce(
      async (params: { fetch?: typeof globalThis.fetch }) =>
        await params.fetch!("https://api.vercel.test/sandboxes", {
          signal: new AbortController().signal,
        }),
    );
    const executor = createTestSandbox();
    executor.configureSkills([]);
    const controller = new AbortController();
    const deadline = new Error("turn deadline");

    const pending = executor.execute({
      toolName: "bash",
      input: { command: "pwd" },
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(sandboxCreateMock).toHaveBeenCalledOnce());
    controller.abort(deadline);

    await expect(pending).rejects.toBe(deadline);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.vercel.test/sandboxes",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("keeps a shared acquisition alive when its first caller is cancelled", async () => {
    const acquisition = mockAbortableSandboxCreate("sbx_shared_after_abort");
    const executor = createTestSandbox();
    executor.configureSkills([]);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstReason = new Error("first turn ended");

    const first = executor.execute({
      toolName: "bash",
      input: { command: "pwd" },
      signal: firstController.signal,
    });
    await vi.waitFor(() => expect(sandboxCreateMock).toHaveBeenCalledOnce());
    const second = executor.execute({
      toolName: "bash",
      input: { command: "pwd" },
      signal: secondController.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    firstController.abort(firstReason);

    await expect(first).rejects.toBe(firstReason);
    expect(acquisition.signal()?.aborted).toBe(false);
    acquisition.release();
    await expect(second).resolves.toBeDefined();
    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
  });

  it("lets a later caller cancel without aborting the shared acquisition", async () => {
    const acquisition = mockAbortableSandboxCreate("sbx_shared_later_abort");
    const executor = createTestSandbox();
    executor.configureSkills([]);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const secondReason = new Error("second turn ended");

    const first = executor.execute({
      toolName: "bash",
      input: { command: "pwd" },
      signal: firstController.signal,
    });
    await vi.waitFor(() => expect(sandboxCreateMock).toHaveBeenCalledOnce());
    const second = executor.execute({
      toolName: "bash",
      input: { command: "pwd" },
      signal: secondController.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    secondController.abort(secondReason);

    await expect(second).rejects.toBe(secondReason);
    expect(acquisition.signal()?.aborted).toBe(false);
    acquisition.release();
    await expect(first).resolves.toBeDefined();
    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
  });

  it("retries an acquisition abandoned by all earlier callers", async () => {
    mockAbortableSandboxCreate("sbx_abandoned");
    const executor = createTestSandbox();
    executor.configureSkills([]);
    const controller = new AbortController();
    const reason = new Error("caller stopped waiting");

    const abandoned = executor.execute({
      toolName: "bash",
      input: { command: "pwd" },
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(sandboxCreateMock).toHaveBeenCalledOnce());

    controller.abort(reason);
    await expect(abandoned).rejects.toBe(reason);

    sandboxCreateMock.mockResolvedValueOnce(makeSandbox("sbx_recovered"));
    const recovered = executor.execute({
      toolName: "bash",
      input: { command: "pwd" },
      signal: new AbortController().signal,
    });

    await expect(recovered).resolves.toBeDefined();
    expect(sandboxCreateMock).toHaveBeenCalledTimes(2);
  });

  it("does not report a reference change when restoring the same sandbox", async () => {
    const restoredSandbox = makeSandbox("sbx_restored");
    const onSandboxAcquired = vi.fn();
    sandboxGetMock.mockResolvedValue(restoredSandbox);

    const executor = createTestSandbox({
      sandboxId: "sbx_restored",
      onSandboxAcquired,
    });
    executor.configureSkills([]);

    await executor.createSandbox();

    expect(onSandboxAcquired).not.toHaveBeenCalled();
  });

  it("keeps restored sandbox policy tracking tied to the applied policy", async () => {
    const restoredSandbox = makeSandbox("sbx_restored_policy");
    const firstPolicy = {
      allow: {
        "*": [],
        "api.first.example": [
          {
            forwardURL: "https://junior.example.com/api/internal/proxy",
          },
        ],
      },
    };
    const secondPolicy = {
      allow: {
        "*": [],
        "api.second.example": [
          {
            forwardURL: "https://junior.example.com/api/internal/proxy",
          },
        ],
      },
    };
    const createNetworkPolicy = vi
      .fn()
      .mockReturnValueOnce(firstPolicy)
      .mockReturnValueOnce(secondPolicy);
    sandboxGetMock.mockResolvedValue(restoredSandbox);

    const manager = createTestSandboxRuntime({
      sandboxId: "sbx_restored_policy",
      createNetworkPolicy,
    });
    manager.configureSkills([]);

    await manager.createSandbox();
    await manager.refreshNetworkPolicy();

    expect(restoredSandbox.update).toHaveBeenNthCalledWith(1, {
      networkPolicy: firstPolicy,
    });
    expect(restoredSandbox.update).toHaveBeenNthCalledWith(2, {
      networkPolicy: secondPolicy,
    });
    expect(createNetworkPolicy).toHaveBeenCalledTimes(2);
  });

  it("keeps network policy tied to the acquired session", async () => {
    const sandbox = makeSandbox("sbx_cached_policy");
    sandboxCreateMock.mockResolvedValue(sandbox);
    let providerDomain = "api.first.example";
    const createNetworkPolicy = vi.fn((sandboxId: string) => ({
      allow: {
        "*": [],
        [providerDomain]: [
          {
            forwardURL: `https://junior.example.com/api/internal/sandbox-egress/${sandboxId}`,
          },
        ],
      },
    }));

    const manager = createTestSandboxRuntime({ createNetworkPolicy });
    manager.configureSkills([]);

    await manager.createSandbox();
    await manager.createSandbox();
    expect(sandbox.update).toHaveBeenCalledTimes(1);
    expect(sandbox.update).toHaveBeenCalledWith({
      networkPolicy: {
        allow: {
          "*": [],
          "api.first.example": [
            {
              forwardURL:
                "https://junior.example.com/api/internal/sandbox-egress/sbx_cached_policy_session",
            },
          ],
        },
      },
    });

    sandbox.currentSession.mockReturnValue({
      sessionId: "sbx_cached_policy_resumed_session",
    });
    await manager.createSandbox();

    expect(sandbox.update).toHaveBeenCalledTimes(1);

    providerDomain = "api.second.example";
    await manager.refreshNetworkPolicy();

    expect(sandbox.update).toHaveBeenCalledTimes(2);
    expect(sandbox.update).toHaveBeenLastCalledWith({
      networkPolicy: {
        allow: {
          "*": [],
          "api.second.example": [
            {
              forwardURL:
                "https://junior.example.com/api/internal/sandbox-egress/sbx_cached_policy_session",
            },
          ],
        },
      },
    });
  });

  it("passes token-based Vercel Sandbox credentials to the sandbox SDK", async () => {
    process.env.VERCEL_TOKEN = "sandbox-token";
    process.env.VERCEL_TEAM_ID = "team_123";
    process.env.VERCEL_PROJECT_ID = "prj_123";

    const freshSandbox = makeSandbox("sbx_fresh");

    sandboxCreateMock.mockResolvedValue(freshSandbox);

    const executor = createTestSandbox();
    executor.configureSkills([]);

    await executor.createSandbox();

    expect(sandboxGetMock).not.toHaveBeenCalled();
    expect(sandboxCreateMock).toHaveBeenCalledWith({
      timeout: 1000 * 60 * 30,
      runtime: "node22",
      token: "sandbox-token",
      teamId: "team_123",
      projectId: "prj_123",
    });
  });

  it("recreates sandbox when dependency profile hash changed", async () => {
    const freshSandbox = makeSandbox("sbx_fresh_after_profile_change");
    hashMock.mockReturnValue("current-profile");
    sandboxCreateMock.mockResolvedValue(freshSandbox);

    const executor = createTestSandbox({
      sandboxId: "sbx_old",
      sandboxDependencyProfileHash: "old-profile",
    });
    executor.configureSkills([]);

    const sandbox = await executor.createSandbox();

    await expectWorkspaceToDelegate(sandbox, freshSandbox);
    expect(sandboxGetMock).not.toHaveBeenCalled();
    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
  });

  it("replaces a live workspace when the same recipe id has a new profile", async () => {
    const initialSandbox = makeSandbox("sbx_workspace_initial");
    const refreshedSandbox = makeSandbox("sbx_workspace_refreshed");
    sandboxCreateMock
      .mockResolvedValueOnce(initialSandbox)
      .mockResolvedValueOnce(refreshedSandbox);
    hashMock
      .mockReturnValueOnce("profile-initial")
      .mockReturnValueOnce("profile-refreshed");
    const workspace = {
      id: "workspace-1",
      name: "sentry",
      setupScript: "",
      snapshot: null,
      repos: [],
    };
    const runtime = createSandboxRuntime({
      workspace,
      skills: [],
      referenceFiles: [],
    });

    await runtime.acquire();
    await runtime.switchWorkspace({
      ...workspace,
    });

    expect(sandboxCreateMock).toHaveBeenCalledTimes(2);
    expect(initialSandbox.stop).toHaveBeenCalledTimes(1);
    expect(runtime.sandboxRef()?.id).toBe("sbx_workspace_refreshed");
  });

  it("keeps the live sandbox when workspace switch is cancelled mid-boot", async () => {
    const initialSandbox = makeSandbox("sbx_workspace_initial");
    const nextSandbox = makeSandbox("sbx_workspace_next");
    let releaseCreate: (() => void) | undefined;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    sandboxCreateMock
      .mockResolvedValueOnce(initialSandbox)
      .mockImplementationOnce(async () => {
        await createGate;
        return nextSandbox;
      });
    hashMock
      .mockReturnValueOnce("profile-initial")
      .mockReturnValueOnce("profile-next");
    const initialWorkspace = {
      id: "workspace-initial",
      name: "initial",
      setupScript: "",
      snapshot: null,
      repos: [],
    };
    const runtime = createSandboxRuntime({
      workspace: initialWorkspace,
      skills: [],
      referenceFiles: [],
    });
    await runtime.acquire();
    const controller = new AbortController();
    const reason = new Error("switch cancelled mid-boot");

    const switchPromise = runtime.switchWorkspace(
      {
        ...initialWorkspace,
        id: "workspace-next",
        name: "next",
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(sandboxCreateMock).toHaveBeenCalledTimes(2));
    controller.abort(reason);
    releaseCreate?.();

    await expect(switchPromise).rejects.toBe(reason);
    expect(initialSandbox.stop).not.toHaveBeenCalled();
    expect(nextSandbox.stop).toHaveBeenCalledTimes(1);
    expect(runtime.sandboxRef()?.id).toBe("sbx_workspace_initial");
  });

  it("keeps a durable same-recipe sandbox when switch is repeated cold", async () => {
    hashMock.mockReturnValue("profile-same");
    const workspace = {
      id: "workspace-1",
      name: "sentry",
      setupScript: "",
      snapshot: null,
      repos: [],
    };
    const runtime = createSandboxRuntime({
      sandboxRef: {
        id: "sbx_workspace_same",
        profileHash: "profile-same",
        workspaceId: "workspace-1",
      },
      workspace,
      skills: [],
      referenceFiles: [],
    });

    await runtime.switchWorkspace(workspace);

    expect(sandboxCreateMock).not.toHaveBeenCalled();
    expect(sandboxGetMock).not.toHaveBeenCalled();
    expect(runtime.sandboxRef()).toEqual({
      id: "sbx_workspace_same",
      profileHash: "profile-same",
      workspaceId: "workspace-1",
    });
  });

  it("discards the Workspace hint when its recipe row is missing", async () => {
    hashMock.mockReturnValue("profile-base");
    const fresh = makeSandbox("sbx_after_recipe_removed");
    sandboxCreateMock.mockResolvedValueOnce(fresh);
    const refs: Array<{
      id: string;
      workspaceId?: string;
      profileHash?: string;
    } | null> = [];
    const runtime = createSandboxRuntime({
      sandboxRef: {
        id: "sbx_missing_recipe",
        profileHash: "profile-workspace",
        workspaceId: "workspace-deleted",
      },
      skills: [],
      referenceFiles: [],
      onSandboxRefChanged: (ref) => {
        refs.push(ref);
      },
    });

    await runtime.acquire();

    expect(sandboxGetMock).not.toHaveBeenCalled();
    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
    expect(runtime.sandboxRef()).toEqual({
      id: "sbx_after_recipe_removed",
      profileHash: "profile-base",
    });
    expect(refs).toEqual([
      {
        id: "sbx_after_recipe_removed",
        profileHash: "profile-base",
      },
    ]);
  });

  it("prepares the active sandbox after loading a ready Workspace snapshot", async () => {
    const activeSandbox = makeSandbox("sbx_workspace_active");
    const onWorkspacePrepare = vi.fn(
      async (_sandbox: SandboxSession, _workspace: unknown) => {},
    );
    getReadyWorkspaceMock.mockResolvedValueOnce({
      snapshotId: "snap_workspace",
      profileHash: "profile-workspace",
      dependencyCount: 0,
      cacheHit: true,
      resolveOutcome: "cache_hit",
    });
    hashMock.mockReturnValue("profile-workspace");
    sandboxCreateMock.mockResolvedValueOnce(activeSandbox);
    const runtime = createSandboxRuntime({
      workspace: {
        id: "workspace-1",
        name: "sentry",
        setupScript: "",
        snapshot: null,
        repos: [],
      },
      skills: [],
      referenceFiles: [],
      onWorkspacePrepare,
    });

    await runtime.acquire();

    expect(onWorkspacePrepare).toHaveBeenCalledOnce();
    expect(onWorkspacePrepare.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ sandboxId: "sbx_workspace_active" }),
    );
    expect(onWorkspacePrepare.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ id: "workspace-1" }),
    );
  });

  it("loads a ready Workspace snapshot without starting a build", async () => {
    const controller = new AbortController();
    getReadyWorkspaceMock.mockResolvedValueOnce({
      snapshotId: "snap_workspace_setup",
      profileHash: "profile-workspace-setup",
      dependencyCount: 0,
      cacheHit: false,
      resolveOutcome: "rebuilt",
    });
    hashMock.mockReturnValue("profile-workspace-setup");
    sandboxCreateMock.mockResolvedValueOnce(makeSandbox("sbx_workspace_setup"));
    const workspace = {
      id: "workspace-setup",
      name: "setup",
      setupScript: "echo ready",
      snapshot: null,
      repos: [],
    };
    const runtime = createSandboxRuntime({
      workspace,
      skills: [],
      referenceFiles: [],
    });

    await runtime.acquire(controller.signal);

    expect(getReadyWorkspaceMock).toHaveBeenCalledWith({
      workspace,
      runtime: "node22",
    });
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("forwards abort signal into Workspace provider preparation", async () => {
    const buildSandbox = makeSandbox("sbx_workspace_provider_signal");
    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    let markProviderStarted: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    getReadyWorkspaceMock.mockImplementationOnce(async (params: any) => {
      await params.prepareRepositories?.(
        buildSandbox,
        params.workspace,
        params.signal,
      );
      return {
        snapshotId: "snap_workspace_provider",
        profileHash: "profile-workspace-provider",
        dependencyCount: 0,
        cacheHit: false,
        resolveOutcome: "built",
      };
    });
    hashMock.mockReturnValue("profile-workspace-provider");
    sandboxCreateMock.mockResolvedValueOnce(
      makeSandbox("sbx_workspace_provider_active"),
    );
    const runtime = createSandboxRuntime({
      workspace: {
        id: "workspace-provider",
        name: "provider",
        setupScript: "",
        snapshot: null,
        repos: [],
      },
      skills: [],
      referenceFiles: [],
      onWorkspacePrepare: async (_sandbox, _workspace, signal) => {
        providerSignal = signal;
        markProviderStarted?.();
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        signal?.throwIfAborted();
      },
    });

    const acquirePromise = runtime.acquire(controller.signal);
    await providerStarted;
    expect(providerSignal).toBeInstanceOf(AbortSignal);
    expect(providerSignal?.aborted).toBe(false);

    controller.abort("cancel provider preparation");

    await expect(acquirePromise).rejects.toBe("cancel provider preparation");
    expect(providerSignal?.aborted).toBe(true);
  });

  it("keeps the durable workspace reference when its switch fails", async () => {
    const initialSandbox = makeSandbox("sbx_workspace_initial");
    const failedSandbox = makeSandbox("sbx_workspace_failed");
    sandboxCreateMock
      .mockResolvedValueOnce(initialSandbox)
      .mockResolvedValueOnce(failedSandbox);
    let prepareCount = 0;
    const refs: Array<{ id: string; workspaceId?: string }> = [];
    const initialWorkspace = {
      id: "workspace-initial",
      name: "initial",
      setupScript: "",
      snapshot: null,
      repos: [],
    };
    const nextWorkspace = {
      ...initialWorkspace,
      id: "workspace-next",
      name: "next",
    };
    const runtime = createSandboxRuntime({
      workspace: initialWorkspace,
      skills: [],
      referenceFiles: [],
      onSandboxPrepare: () => {
        prepareCount += 1;
        if (prepareCount === 2) {
          throw new Error("prepare failed");
        }
      },
      onSandboxRefChanged: async (ref) => {
        refs.push(ref);
      },
    });

    await runtime.acquire();
    await expect(runtime.switchWorkspace(nextWorkspace)).rejects.toThrow(
      "sandbox setup failed",
    );

    // Failed replacement is stopped before it can replace durable or live state.
    expect(refs).toEqual([
      { id: "sbx_workspace_initial", workspaceId: "workspace-initial" },
    ]);
    expect(runtime.sandboxRef()?.id).toBe("sbx_workspace_initial");
    expect(failedSandbox.stop).toHaveBeenCalledTimes(1);
    expect(initialSandbox.stop).not.toHaveBeenCalled();
  });

  it("waits for an in-flight acquisition before workspace switch", async () => {
    const lateSandbox = makeSandbox("sbx_workspace_late_inflight");
    const nextSandbox = makeSandbox("sbx_workspace_switch_target");
    let releaseCreate: (() => void) | undefined;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    sandboxCreateMock
      .mockImplementationOnce(async () => {
        await createGate;
        return lateSandbox;
      })
      .mockResolvedValueOnce(nextSandbox);
    hashMock
      .mockReturnValueOnce("profile-initial")
      .mockReturnValueOnce("profile-next");
    const initialWorkspace = {
      id: "workspace-initial",
      name: "initial",
      setupScript: "",
      snapshot: null,
      repos: [],
    };
    const nextWorkspace = {
      ...initialWorkspace,
      id: "workspace-next",
      name: "next",
    };
    const runtime = createSandboxRuntime({
      workspace: initialWorkspace,
      skills: [],
      referenceFiles: [],
    });

    // Cold acquire is still in flight when the switch starts.
    const pendingAcquire = runtime.acquire();
    await vi.waitFor(() => expect(sandboxCreateMock).toHaveBeenCalledTimes(1));

    const switchPromise = runtime.switchWorkspace(nextWorkspace);
    // Finish the current acquisition before the candidate build starts.
    releaseCreate?.();
    await pendingAcquire;
    await switchPromise;

    expect(lateSandbox.stop).toHaveBeenCalledTimes(1);
    expect(nextSandbox.stop).not.toHaveBeenCalled();
    expect(sandboxGetMock).not.toHaveBeenCalled();
    expect(runtime.sandboxRef()?.id).toBe("sbx_workspace_switch_target");
  });

  it("surfaces a generic sandbox setup failure for non-recoverable sync errors", async () => {
    const forbiddenSandbox = makeSandbox("sbx_forbidden", {
      mkDirError: createApiError(
        403,
        "Forbidden",
        "forbidden",
        "You do not have permission to access this sandbox",
      ),
    });

    sandboxGetMock.mockResolvedValue(forbiddenSandbox);

    const executor = createTestSandbox({ sandboxId: "sbx_forbidden" });
    executor.configureSkills([]);

    await expect(executor.createSandbox()).rejects.toThrow(
      "sandbox setup failed",
    );
    expect(sandboxCreateMock).not.toHaveBeenCalled();
  });

  it("does not replace a hinted sandbox after an unrelated restore failure", async () => {
    sandboxGetMock.mockRejectedValueOnce(
      createApiError(
        500,
        "Internal Server Error",
        "sandbox_api_error",
        "Sandbox API failed",
      ),
    );

    const executor = createTestSandbox({ sandboxId: "sbx_restore_error" });
    executor.configureSkills([]);

    const error = await executor.createSandbox().catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: "sandbox restore failed" });
    expect(sandboxCreateMock).not.toHaveBeenCalled();
  });

  it("defers to SDK OIDC resolution when VERCEL_OIDC_TOKEN is set without explicit credentials", async () => {
    process.env.VERCEL_OIDC_TOKEN = "oidc-jwt-token";
    process.env.VERCEL_TEAM_ID = "team_123";
    process.env.VERCEL_PROJECT_ID = "prj_123";

    const freshSandbox = makeSandbox("sbx_oidc");
    sandboxCreateMock.mockResolvedValue(freshSandbox);

    const executor = createTestSandbox();
    executor.configureSkills([]);

    await executor.createSandbox();

    expect(sandboxCreateMock).toHaveBeenCalledWith({
      timeout: 1000 * 60 * 30,
      runtime: "node22",
    });
  });

  it("configures resources for fresh sandboxes", async () => {
    process.env.SANDBOX_VCPUS = "4";
    const freshSandbox = makeSandbox("sbx_resources");
    sandboxCreateMock.mockResolvedValue(freshSandbox);

    const executor = createTestSandbox();
    executor.configureSkills([]);

    await executor.createSandbox();

    expect(sandboxCreateMock).toHaveBeenCalledWith({
      timeout: 1000 * 60 * 30,
      runtime: "node22",
      resources: { vcpus: 4 },
    });
  });

  it("runs bash commands through a noninteractive shell", async () => {
    const sandbox = makeSandbox("sbx_bash");
    sandboxGetMock.mockResolvedValue(sandbox);

    const executor = createTestSandbox({ sandboxId: "sbx_bash" });
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

  it("runs bash in an explicit workspace cwd", async () => {
    const sandbox = makeSandbox("sbx_bash_cwd");
    sandboxGetMock.mockResolvedValue(sandbox);

    const executor = createTestSandbox({ sandboxId: "sbx_bash_cwd" });
    executor.configureSkills([]);

    const response = await executor.execute<StructuredSandboxResult>({
      toolName: "bash",
      input: {
        command: "pwd",
        cwd: "repo/packages/api",
      },
    });

    expect(sandbox.runCommand.mock.calls[0]?.[0]).toMatchObject({
      cmd: "bash",
      cwd: "/vercel/sandbox/repo/packages/api",
    });
    expect(response.result.details).toMatchObject({
      cwd: "/vercel/sandbox/repo/packages/api",
    });
  });

  it("applies a host timeout to bash commands when the model omits one", async () => {
    vi.useFakeTimers();
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

    const executor = createTestSandbox({ sandboxId: "sbx_bash_timeout" });
    executor.configureSkills([]);

    const responsePromise = executor.execute<StructuredSandboxResult>({
      toolName: "bash",
      input: {
        command: "sleep 999",
      },
    });

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    const response = await responsePromise;

    expect(response.result.details).toMatchObject({
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

    const executor = createTestSandbox({ sandboxId: "sbx_bash_abort" });
    executor.configureSkills([]);
    const abortController = new AbortController();

    const responsePromise = executor.execute<StructuredSandboxResult>({
      toolName: "bash",
      input: {
        command: "sleep 999",
      },
      signal: abortController.signal,
    });

    await vi.waitFor(() => expect(sandbox.runCommand).toHaveBeenCalledOnce());
    abortController.abort();
    const response = await responsePromise;

    expect(response.result.details).toMatchObject({
      exit_code: 130,
      timed_out: false,
      stderr: "Command aborted because the agent turn was cancelled.",
    });
  });

  it("marks an aborted mutation with completed side effects as outcome unknown", async () => {
    let remoteMutationApplied = false;
    const sandbox = makeSandbox("sbx_bash_ambiguous_mutation");
    sandbox.runCommand.mockImplementationOnce(
      async (input) =>
        await new Promise((_, reject) => {
          input.signal?.addEventListener("abort", () => {
            remoteMutationApplied = true;
            reject(
              new Error(
                "command stream aborted after upstream accepted mutation",
              ),
            );
          });
        }),
    );
    sandboxGetMock.mockResolvedValue(sandbox);

    const executor = createTestSandbox({
      sandboxId: "sbx_bash_ambiguous_mutation",
    });
    executor.configureSkills([]);
    const abortController = new AbortController();
    const responsePromise = executor.execute<StructuredSandboxResult>({
      toolName: "bash",
      input: { command: "git push origin HEAD" },
      signal: abortController.signal,
    });

    for (
      let attempt = 0;
      attempt < 100 && !sandbox.runCommand.mock.calls.length;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(sandbox.runCommand).toHaveBeenCalledTimes(1);
    abortController.abort();
    const response = await responsePromise;

    expect(remoteMutationApplied).toBe(true);
    expect(response.result.details).toMatchObject({
      exit_code: 130,
      aborted: true,
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

    const manager = createTestSandboxRuntime({
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

    const executor = createTestSandbox({
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
          "github returned HTTP 403 after the runtime injected the user-write grant. The request was forwarded; this is not a local runtime block.",
        source: "upstream",
        status: 403,
        upstreamHost: "github.com",
        upstreamPath: "/getsentry/junior.git/info/refs",
      },
    );

    const executor = createTestSandbox({
      sandboxId: "sbx_stale_auth_signal",
    });
    executor.configureSkills([]);

    const response = await executor.execute<StructuredSandboxResult>({
      toolName: "bash",
      input: {
        command: "printf stale",
      },
    });

    expect(response.result.details.exit_code).toBe(1);
    expect(response.result.details.auth_required).toBeUndefined();
    expect(response.result.details.permission_denied).toBeUndefined();
  });

  it("attaches sandbox egress auth signals to bash results regardless of exit code", async () => {
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

    const executor = createTestSandbox({
      sandboxId: "sbx_fresh_auth_signal",
    });
    executor.configureSkills([]);

    const response = await executor.execute<StructuredSandboxResult>({
      toolName: "bash",
      input: {
        command: "gh issue create",
      },
    });

    expect(response.result.details.exit_code).toBe(1);
    expect(response.result.details.auth_required).toMatchObject({
      provider: "github",
      grant: {
        name: "user-write",
        access: "write",
      },
    });
  });

  it("attaches sandbox egress auth signals to bash results with exit code 0 (pipe-masked failures)", async () => {
    // Regression test: piped bash commands (e.g. `cmd | head`) mask the
    // underlying CLI exit code with 0 from the pipe tail. The auth signal must
    // still be surfaced so the OAuth flow can be triggered.
    const sandbox = makeSandbox("sbx_pipe_masked_auth_signal");
    sandbox.runCommand.mockImplementationOnce(async () => {
      await setSandboxEgressAuthRequiredSignal(
        {
          credentials: { actor: { type: "user" as const, userId: "U123" } },
          egressId: "sbx_pipe_masked_auth_signal_session",
          expiresAtMs: Date.now() + 60_000,
          contextId: "ctx-pipe-masked",
        },
        {
          provider: "sentry",
          grant: {
            name: "default",
            access: "read",
          },
          authorization: {
            type: "oauth",
            provider: "sentry",
          },
        },
      );
      return {
        exitCode: 0, // pipe tail (head/grep) always exits 0
        stdout: async () =>
          '"junior-auth-required provider=sentry grant=default access=read 401 unauthorized"',
        stderr: async () => "",
      };
    });
    sandboxGetMock.mockResolvedValue(sandbox);

    const executor = createTestSandbox({
      sandboxId: "sbx_pipe_masked_auth_signal",
    });
    executor.configureSkills([]);

    const response = await executor.execute<StructuredSandboxResult>({
      toolName: "bash",
      input: {
        command: "sentry org list --json 2>&1 | head -20",
      },
    });

    expect(response.result.details.exit_code).toBe(0);
    // Auth signal must be attached even though exit_code is 0
    expect(response.result.details.auth_required).toMatchObject({
      provider: "sentry",
      grant: {
        name: "default",
        access: "read",
      },
    });
  });

  it("attaches sandbox egress permission signals to bash results regardless of exit code", async () => {
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
            reason: "github.installation-write",
          },
          message:
            "github returned HTTP 403 after the runtime injected the user-write grant. The request was forwarded; this is not a local runtime block.",
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

    const executor = createTestSandbox({
      sandboxId: "sbx_permission_signal",
    });
    executor.configureSkills([]);

    const response = await executor.execute<StructuredSandboxResult>({
      toolName: "bash",
      input: {
        command: "git push",
      },
    });

    expect(response.result.details.exit_code).toBe(1);
    expect(response.result.details.permission_denied).toMatchObject({
      provider: "github",
      grant: {
        name: "user-write",
        access: "write",
        reason: "github.installation-write",
      },
      message:
        "github returned HTTP 403 after the runtime injected the user-write grant. The request was forwarded; this is not a local runtime block.",
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

    const executor = createTestSandbox({
      sandboxId: "sbx_mixed_auth_signal",
    });
    executor.configureSkills([]);

    const response = await executor.execute<StructuredSandboxResult>({
      toolName: "bash",
      input: {
        command: "gh issue create",
      },
    });

    expect(response.result.details.exit_code).toBe(1);
    expect(response.result.details.auth_required).toMatchObject({
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
        credentials: { actor: { platform: "system", name: "scheduler" } },
        egressId: "sbx_authorize_system_credentials_session",
      });
      return {
        exitCode: 0,
        stdout: async () => "",
        stderr: async () => "",
      };
    });
    sandboxGetMock.mockResolvedValue(sandbox);

    const executor = createTestSandbox({
      sandboxId: "sbx_authorize_system_credentials",
      credentialEgress: {
        actor: { platform: "system", name: "scheduler" },
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

    const executor = createTestSandbox({
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

  it("returns a tool error when the bash command stream ends without a status", async () => {
    const streamError = createStreamInterruptedError();
    const sandbox = makeSandbox("sbx_stream_interrupted");
    sandbox.runCommand.mockRejectedValueOnce(streamError);
    sandboxGetMock.mockResolvedValue(sandbox);

    const executor = createTestSandbox({
      sandboxId: "sbx_stream_interrupted",
    });
    executor.configureSkills([]);

    const error = await executor
      .execute<StructuredSandboxResult>({
        toolName: "bash",
        input: {
          command: "pnpm test",
        },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ToolInputError);
    expect(error).toMatchObject({
      message: expect.stringContaining(
        "The sandbox command stream was interrupted during bash",
      ),
    });
  });

  it("returns tool errors when file-tool command streams end", async () => {
    const sandbox = makeSandbox("sbx_find_files_interrupted");
    sandbox.fs.stat.mockRejectedValueOnce(createStreamInterruptedError());
    sandboxCreateMock.mockResolvedValueOnce(sandbox);

    const executor = createTestSandbox();
    executor.configureSkills([]);

    const error = await executor
      .execute<StructuredSandboxResult>({
        toolName: "findFiles",
        input: { pattern: "*.ts" },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ToolInputError);
    expect(error).toMatchObject({
      message: expect.stringContaining(
        "The sandbox command stream was interrupted during findFiles",
      ),
    });
  });

  it("preserves turn cancellation when ripgrep reports an interrupted stream", async () => {
    const sandbox = makeSandbox("sbx_aborted_find_files");
    const abortReason = new Error("agent turn cancelled");
    let markCommandStarted: () => void = () => {};
    const commandStarted = new Promise<void>((resolve) => {
      markCommandStarted = resolve;
    });
    sandbox.fs.stat.mockResolvedValueOnce({ isDirectory: () => true });
    sandbox.runCommand.mockImplementationOnce(
      async (input: { signal?: AbortSignal }) =>
        await new Promise<never>((_resolve, reject) => {
          markCommandStarted();
          const missingSignalTimeout = setTimeout(
            () => reject(new Error("abort signal was not propagated")),
            100,
          );
          input.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(missingSignalTimeout);
              reject(createStreamInterruptedError());
            },
            { once: true },
          );
        }),
    );
    sandboxGetMock.mockResolvedValueOnce(sandbox);

    const executor = createTestSandbox({
      sandboxId: "sbx_aborted_find_files",
    });
    executor.configureSkills([]);
    const controller = new AbortController();
    const operation = executor.execute<StructuredSandboxResult>({
      toolName: "findFiles",
      input: { pattern: "*.ts" },
      signal: controller.signal,
    });
    await commandStarted;

    controller.abort(abortReason);

    await expect(operation).rejects.toBe(abortReason);
    expect(sandbox.fs.stat).toHaveBeenCalledTimes(1);
    expect(sandbox.runCommand).toHaveBeenCalledTimes(1);
  });

  it("invalidates an unavailable sandbox and lets a later tool call recover", async () => {
    const closedSandbox = makeSandbox("sbx_closed_file_tools");
    const recoveredSandbox = makeSandbox("sbx_closed_file_tools");
    closedSandbox.fs.stat.mockRejectedValueOnce(createClosedStreamError());
    recoveredSandbox.fs.stat.mockResolvedValue({ isDirectory: () => true });
    recoveredSandbox.fs.readdir.mockResolvedValue([]);
    hashMock.mockReturnValue("profile-v1");
    sandboxCreateMock.mockResolvedValueOnce(closedSandbox);
    sandboxGetMock.mockResolvedValueOnce(recoveredSandbox);

    const executor = createTestSandbox({
      onSandboxAcquired: vi.fn(),
    });
    executor.configureSkills([]);

    const unavailable = await executor
      .execute<StructuredSandboxResult>({
        toolName: "grep",
        input: { pattern: "needle" },
      })
      .catch((error: unknown) => error);

    expect(unavailable).toBeInstanceOf(ToolInputError);
    expect(unavailable).toMatchObject({
      message: expect.stringContaining(
        "The temporary sandbox became unavailable during grep",
      ),
    });
    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
    expect(sandboxGetMock).not.toHaveBeenCalled();

    const recovered = await executor.execute<StructuredSandboxResult>({
      toolName: "grep",
      input: { pattern: "needle" },
    });

    expect(recovered.result.details).toMatchObject({
      match_count: 0,
    });
    expect(sandboxGetMock).toHaveBeenCalledTimes(1);
    expect(sandboxGetMock).toHaveBeenCalledWith({
      name: closedSandbox.name,
      resume: true,
    });
    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
  });

  it("does not let a late stale-session failure invalidate the recovered session", async () => {
    const unavailable = createClosedStreamError();
    const staleSandbox = makeSandbox("sbx_parallel_recovery");
    const recoveredSandbox = makeSandbox("sbx_parallel_recovery");
    recoveredSandbox.session.sessionId =
      "sbx_parallel_recovery_recovered_session";
    let rejectStaleOperation: () => void = () => {};
    let markStaleOperationStarted: () => void = () => {};
    const staleOperationStarted = new Promise<void>((resolve) => {
      markStaleOperationStarted = resolve;
    });
    staleSandbox.fs.stat
      .mockImplementationOnce(
        async () =>
          await new Promise<never>((_resolve, reject) => {
            rejectStaleOperation = () => reject(unavailable);
            markStaleOperationStarted();
          }),
      )
      .mockRejectedValueOnce(unavailable);
    recoveredSandbox.fs.stat.mockResolvedValue({
      isDirectory: () => true,
    });
    recoveredSandbox.fs.readdir.mockResolvedValue([]);
    sandboxGetMock
      .mockResolvedValueOnce(staleSandbox)
      .mockResolvedValueOnce(recoveredSandbox);

    const executor = createTestSandbox({
      sandboxId: staleSandbox.name,
    });
    executor.configureSkills([]);

    const staleOperation = executor.execute<StructuredSandboxResult>({
      toolName: "findFiles",
      input: { pattern: "*.ts" },
    });
    await staleOperationStarted;

    const invalidatingError = await executor
      .execute<StructuredSandboxResult>({
        toolName: "findFiles",
        input: { pattern: "*.ts" },
      })
      .catch((error: unknown) => error);
    expect(invalidatingError).toBeInstanceOf(ToolInputError);

    await expect(
      executor.execute<StructuredSandboxResult>({
        toolName: "findFiles",
        input: { pattern: "*.ts" },
      }),
    ).resolves.toBeDefined();

    rejectStaleOperation();
    await expect(staleOperation).rejects.toBeInstanceOf(ToolInputError);

    await expect(
      executor.execute<StructuredSandboxResult>({
        toolName: "findFiles",
        input: { pattern: "*.ts" },
      }),
    ).resolves.toBeDefined();
    expect(sandboxGetMock).toHaveBeenCalledTimes(2);
  });

  it("does not replay unavailable command output and recovers later", async () => {
    const unavailableError = createClosedStreamError();
    const sandbox = makeSandbox("sbx_closed_bash");
    sandbox.runCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: async () => {
        throw unavailableError;
      },
      stderr: async () => "",
    });
    const recoveredSandbox = makeSandbox("sbx_closed_bash");
    recoveredSandbox.runCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: async () => "recovered\n",
      stderr: async () => "",
    });
    sandboxGetMock
      .mockResolvedValueOnce(sandbox)
      .mockResolvedValueOnce(recoveredSandbox);

    const executor = createTestSandbox({
      sandboxId: sandbox.name,
    });
    executor.configureSkills([]);

    const unavailable = await executor
      .execute<StructuredSandboxResult>({
        toolName: "bash",
        input: { command: "gh pr create" },
      })
      .catch((error: unknown) => error);

    expect(unavailable).toBeInstanceOf(ToolInputError);
    expect(unavailable).toMatchObject({
      message: expect.stringContaining(
        "The temporary sandbox became unavailable during bash",
      ),
    });
    expect(sandbox.runCommand).toHaveBeenCalledTimes(1);
    expect(sandboxGetMock).toHaveBeenCalledTimes(1);
    expect(sandboxCreateMock).not.toHaveBeenCalled();

    await expect(
      executor.execute<StructuredSandboxResult>({
        toolName: "bash",
        input: { command: "git status --short" },
      }),
    ).resolves.toMatchObject({
      result: {
        details: {
          stdout: "recovered\n",
        },
      },
    });
    expect(sandbox.runCommand).toHaveBeenCalledTimes(1);
    expect(recoveredSandbox.runCommand).toHaveBeenCalledTimes(1);
    expect(sandboxGetMock).toHaveBeenCalledTimes(2);
  });

  it("recognizes stream interruptions wrapped by writeFile errors", async () => {
    const sandbox = makeSandbox("sbx_write_file_interrupted");
    sandbox.fs.writeFile.mockImplementationOnce(async () => {
      throw createStreamInterruptedError();
    });
    sandboxCreateMock.mockResolvedValueOnce(sandbox);

    const executor = createTestSandbox();
    executor.configureSkills([]);

    const error = await executor
      .execute<StructuredSandboxResult>({
        toolName: "writeFile",
        input: { path: "file.ts", content: "new content" },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ToolInputError);
    expect(error).toMatchObject({
      message: expect.stringContaining(
        "The sandbox command stream was interrupted during writeFile",
      ),
    });
  });

  it("preserves writeFile workspace path errors", async () => {
    const sandbox = makeSandbox("sbx_write_file_outside_workspace");
    sandboxCreateMock.mockResolvedValueOnce(sandbox);

    const executor = createTestSandbox();
    executor.configureSkills([]);

    const error = await executor
      .execute({
        toolName: "writeFile",
        input: { path: "/etc/passwd", content: "new content" },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ToolInputError);
    expect(error).toMatchObject({
      message: "Path must stay within /vercel/sandbox: /etc/passwd",
    });
    expect(sandbox.fs.writeFile).not.toHaveBeenCalled();
  });

  it("syncs sandbox files once when the first tool call initializes the sandbox", async () => {
    const sandbox = makeSandbox("sbx_single_sync");
    sandboxCreateMock.mockResolvedValue(sandbox);

    const executor = createTestSandbox();
    executor.configureSkills([]);

    await executor.execute({
      toolName: "bash",
      input: {
        command: "echo ok",
      },
    });

    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
    expect(sandbox.writeFiles).toHaveBeenCalledTimes(1);
  });

  it("extends sandbox keepalive while the turn is active", async () => {
    vi.useFakeTimers();
    process.env.VERCEL_SANDBOX_KEEPALIVE_MS = "5000";
    const sandbox = makeSandbox("sbx_active_keepalive");
    sandboxCreateMock.mockResolvedValue(sandbox);

    const runtime = createTestSandboxRuntime();
    runtime.configureSkills([]);
    await runtime.ensureToolExecutors();

    expect(sandbox.extendTimeout).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2500);
    expect(sandbox.extendTimeout).toHaveBeenCalledTimes(2);

    runtime.close();
    await vi.advanceTimersByTimeAsync(2500);
    expect(sandbox.extendTimeout).toHaveBeenCalledTimes(2);
  });

  it("does not reschedule keepalive when closed during an extension", async () => {
    vi.useFakeTimers();
    process.env.VERCEL_SANDBOX_KEEPALIVE_MS = "5000";
    const sandbox = makeSandbox("sbx_close_during_keepalive");
    sandboxCreateMock.mockResolvedValue(sandbox);

    const runtime = createTestSandboxRuntime();
    runtime.configureSkills([]);
    await runtime.ensureToolExecutors();

    let finishExtension!: () => void;
    sandbox.extendTimeout.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          finishExtension = resolve;
        }),
    );
    vi.advanceTimersByTime(2500);
    await Promise.resolve();
    expect(sandbox.extendTimeout).toHaveBeenCalledTimes(2);

    runtime.close();
    finishExtension();
    await vi.advanceTimersByTimeAsync(2500);
    expect(sandbox.extendTimeout).toHaveBeenCalledTimes(2);
  });

  it("extends sandbox keepalive for each tool execution", async () => {
    process.env.VERCEL_SANDBOX_KEEPALIVE_MS = "5000";
    const sandbox = makeSandbox("sbx_keepalive");
    sandboxCreateMock.mockResolvedValue(sandbox);

    const executor = createTestSandbox();
    executor.configureSkills([]);

    await executor.execute({
      toolName: "bash",
      input: {
        command: "echo first",
      },
    });
    await executor.execute({
      toolName: "bash",
      input: {
        command: "echo second",
      },
    });

    expect(sandbox.extendTimeout).toHaveBeenCalledTimes(2);
    expect(sandbox.extendTimeout).toHaveBeenNthCalledWith(1, 5000);
    expect(sandbox.extendTimeout).toHaveBeenNthCalledWith(2, 5000);
  });

  it("fails the current tool when keepalive finds an unavailable session", async () => {
    process.env.VERCEL_SANDBOX_KEEPALIVE_MS = "5000";
    const unavailable = createClosedStreamError();
    const firstSandbox = makeSandbox("sbx_keepalive_recovery");
    firstSandbox.extendTimeout.mockRejectedValueOnce(unavailable);
    const recoveredSandbox = makeSandbox("sbx_keepalive_recovery");
    recoveredSandbox.session.sessionId = "sbx_keepalive_recovered_session";
    sandboxCreateMock.mockResolvedValueOnce(firstSandbox);
    sandboxGetMock.mockResolvedValueOnce(recoveredSandbox);

    const executor = createTestSandbox();
    executor.configureSkills([]);

    await expect(
      executor.execute({
        toolName: "bash",
        input: { command: "echo first" },
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "The temporary sandbox became unavailable during bash",
      ),
      cause: unavailable,
    });
    await expect(
      executor.execute({
        toolName: "bash",
        input: { command: "echo second" },
      }),
    ).resolves.toBeDefined();

    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
    expect(sandboxGetMock).toHaveBeenCalledTimes(1);
  });

  it("does not re-sync skills when reusing a cached sandbox", async () => {
    const sandbox = makeSandbox("sbx_cached_once");
    sandboxCreateMock.mockResolvedValue(sandbox);

    const executor = createTestSandbox();
    executor.configureSkills([]);

    await executor.execute({
      toolName: "bash",
      input: {
        command: "echo first",
      },
    });
    await executor.execute({
      toolName: "bash",
      input: {
        command: "echo second",
      },
    });

    expect(sandbox.writeFiles).toHaveBeenCalledTimes(1);
  });

  it("fails a stopped cached session and reacquires it on a later tool call", async () => {
    const stoppedSandboxError = createApiError(
      410,
      "Gone",
      "sandbox_stopped",
      "Sandbox has stopped execution and is no longer available",
    );
    const firstSandbox = makeSandbox("sbx_cached_first");
    let stopCachedSandbox = false;
    firstSandbox.mkDir.mockImplementation(async (directory: string) => {
      if (stopCachedSandbox && directory === SANDBOX_WORKSPACE_ROOT) {
        throw stoppedSandboxError;
      }
    });
    firstSandbox.runCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: async () => "first\n",
      stderr: async () => "",
    });

    const secondSandbox = makeSandbox("sbx_cached_first");
    secondSandbox.runCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: async () => "second\n",
      stderr: async () => "",
    });

    sandboxCreateMock.mockResolvedValueOnce(firstSandbox);
    sandboxGetMock.mockResolvedValueOnce(secondSandbox);

    const executor = createTestSandbox();
    executor.configureSkills([]);

    await executor.execute({
      toolName: "bash",
      input: {
        command: "echo first",
      },
    });
    stopCachedSandbox = true;

    const interrupted = await executor
      .execute<StructuredSandboxResult>({
        toolName: "bash",
        input: {
          command: "echo second",
        },
      })
      .catch((error: unknown) => error);

    expect(interrupted).toBeInstanceOf(ToolInputError);
    expect(interrupted).toMatchObject({
      message: expect.stringContaining(
        "The temporary sandbox became unavailable during bash",
      ),
    });

    const recovered = await executor.execute<StructuredSandboxResult>({
      toolName: "bash",
      input: {
        command: "echo second",
      },
    });

    expect(recovered.result.details).toMatchObject({
      stdout: "second\n",
      exit_code: 0,
    });
    expect(firstSandbox.writeFiles).toHaveBeenCalledTimes(1);
    expect(firstSandbox.runCommand).toHaveBeenCalledTimes(1);
    expect(secondSandbox.runCommand).toHaveBeenCalledTimes(1);
    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
    expect(sandboxGetMock).toHaveBeenCalledWith({
      name: "sbx_cached_first",
      resume: true,
    });
  });

  it("reads virtual skill files without booting a sandbox before sandbox state exists", async () => {
    const skillRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-skill-read-"),
    );
    await fs.mkdir(path.join(skillRoot, "references"));
    await fs.writeFile(
      path.join(skillRoot, "references", "note.md"),
      "Reference note",
      "utf8",
    );

    const executor = createTestSandbox();
    executor.configureSkills([
      {
        name: "demo-skill",
        description: "Demo skill",
        skillPath: skillRoot,
      },
    ]);

    const response = await executor.execute<StructuredSandboxResult>({
      toolName: "readFile",
      input: {
        path: `${sandboxSkillDir("demo-skill")}/references/note.md`,
      },
    });

    expect(response.result.details).toMatchObject({
      target: `${sandboxSkillDir("demo-skill")}/references/note.md`,
      truncated: false,
      content: "Reference note",
      end_line: 1,
      path: `${sandboxSkillDir("demo-skill")}/references/note.md`,
      start_line: 1,
      total_lines: 1,
    });
    expect(sandboxGetMock).not.toHaveBeenCalled();
    expect(sandboxCreateMock).not.toHaveBeenCalled();
  });

  it("falls through to sandbox when a virtual skill file is missing on the host", async () => {
    const skillRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-skill-read-missing-"),
    );
    const sandbox = makeSandbox("sbx_missing_virtual_skill_file");
    sandbox.fs.readFile.mockResolvedValueOnce("from sandbox");
    sandboxCreateMock.mockResolvedValue(sandbox);

    const executor = createTestSandbox();
    executor.configureSkills([
      {
        name: "demo-skill",
        description: "Demo skill",
        skillPath: skillRoot,
      },
    ]);

    const response = await executor.execute<StructuredSandboxResult>({
      toolName: "readFile",
      input: {
        path: `${sandboxSkillDir("demo-skill")}/references/missing.md`,
      },
    });

    expect(response.result.details).toMatchObject({
      target: `${sandboxSkillDir("demo-skill")}/references/missing.md`,
      truncated: false,
      content: "from sandbox",
      end_line: 1,
      path: `${sandboxSkillDir("demo-skill")}/references/missing.md`,
      start_line: 1,
      total_lines: 1,
    });
    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
  });

  it("returns a readFile tool result when the sandbox path is missing", async () => {
    const sandbox = makeSandbox("sbx_missing_read_file");
    sandbox.fs.readFile.mockRejectedValueOnce(
      new Error("File not found: /vercel/sandbox/missing.ts"),
    );
    sandboxCreateMock.mockResolvedValue(sandbox);

    const executor = createTestSandbox();
    executor.configureSkills([]);

    await expect(
      executor.execute<StructuredSandboxResult>({
        toolName: "readFile",
        input: { path: "missing.ts" },
      }),
    ).rejects.toThrow("File not found: missing.ts");
  });

  it("returns a structured failure when editFile targets a missing path", async () => {
    const sandbox = makeSandbox("sbx_missing_edit_file");
    sandbox.fs.readFile.mockRejectedValue(
      Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      }),
    );
    sandboxCreateMock.mockResolvedValue(sandbox);

    const executor = createTestSandbox();
    executor.configureSkills([]);

    await expect(
      executor.execute({
        toolName: "editFile",
        input: {
          path: "missing.ts",
          edits: [{ oldText: "a", newText: "b" }],
        },
      }),
    ).rejects.toThrow("File not found: missing.ts");
  });

  it("keeps non-lifecycle sandbox API failures as readFile errors", async () => {
    const sandbox = makeSandbox("sbx_read_file_api_error");
    sandbox.fs.readFile.mockRejectedValueOnce(
      createApiError(
        500,
        "Internal Server Error",
        "sandbox_api_error",
        "Sandbox API failed",
      ),
    );
    sandboxCreateMock.mockResolvedValue(sandbox);

    const executor = createTestSandbox();
    executor.configureSkills([]);

    await expect(
      executor.execute({
        toolName: "readFile",
        input: {
          path: "missing.ts",
        },
      }),
    ).rejects.toThrow("Status code 500 is not ok");
  });

  it("reads virtual skill files from sandbox when a sandbox id hint exists", async () => {
    const skillRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-skill-read-hinted-"),
    );
    await fs.mkdir(path.join(skillRoot, "references"));
    await fs.writeFile(
      path.join(skillRoot, "references", "note.md"),
      "Host note",
      "utf8",
    );
    const sandbox = makeSandbox("sbx_existing");
    sandbox.fs.readFile.mockResolvedValueOnce("Sandbox note");
    sandboxGetMock.mockResolvedValue(sandbox);

    const executor = createTestSandbox({ sandboxId: "sbx_existing" });
    executor.configureSkills([
      {
        name: "demo-skill",
        description: "Demo skill",
        skillPath: skillRoot,
      },
    ]);

    const response = await executor.execute<StructuredSandboxResult>({
      toolName: "readFile",
      input: {
        path: `${sandboxSkillDir("demo-skill")}/references/note.md`,
      },
    });

    expect(response.result.details).toMatchObject({
      target: `${sandboxSkillDir("demo-skill")}/references/note.md`,
      truncated: false,
      content: "Sandbox note",
      end_line: 1,
      path: `${sandboxSkillDir("demo-skill")}/references/note.md`,
      start_line: 1,
      total_lines: 1,
    });
    expect(sandboxGetMock).toHaveBeenCalledWith({
      name: "sbx_existing",
      resume: true,
    });
  });

  it("creates fresh sandboxes from dependency snapshots when available", async () => {
    process.env.SANDBOX_VCPUS = "4";
    const snapshotSandbox = makeSandbox("sbx_snapshot");
    resolveMock.mockResolvedValue({
      snapshotId: "snap_123",
      profileHash: "hash_123",
      dependencyCount: 2,
      cacheHit: true,
      resolveOutcome: "cache_hit",
    });
    sandboxCreateMock.mockResolvedValue(snapshotSandbox);

    const executor = createTestSandbox();
    executor.configureSkills([]);

    const sandbox = await executor.createSandbox();

    await expectWorkspaceToDelegate(sandbox, snapshotSandbox);
    expect(sandboxCreateMock).toHaveBeenCalledWith({
      timeout: 1000 * 60 * 30,
      source: {
        type: "snapshot",
        snapshotId: "snap_123",
      },
      resources: { vcpus: 4 },
    });
  });

  it("rebuilds snapshot when cached snapshot is missing", async () => {
    const rebuiltSandbox = makeSandbox("sbx_rebuilt");
    resolveMock
      .mockResolvedValueOnce({
        snapshotId: "snap_missing",
        profileHash: "hash_1",
        dependencyCount: 2,
        cacheHit: true,
        resolveOutcome: "cache_hit",
      })
      .mockResolvedValueOnce({
        snapshotId: "snap_rebuilt",
        profileHash: "hash_1",
        dependencyCount: 2,
        cacheHit: false,
        resolveOutcome: "forced_rebuild",
        rebuildReason: "snapshot_missing",
      });
    const missingError = new Error("snapshot not found");
    sandboxCreateMock
      .mockRejectedValueOnce(missingError)
      .mockResolvedValueOnce(rebuiltSandbox);
    missingErrorMock.mockImplementation(
      (error: unknown) => error === missingError,
    );

    const executor = createTestSandbox();
    executor.configureSkills([]);

    const sandbox = await executor.createSandbox();

    await expectWorkspaceToDelegate(sandbox, rebuiltSandbox);
    expect(resolveMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        runtime: "node22",
        timeoutMs: 1000 * 60 * 30,
        forceRebuild: true,
        staleSnapshotId: "snap_missing",
      }),
    );
    expect(sandboxCreateMock).toHaveBeenNthCalledWith(2, {
      timeout: 1000 * 60 * 30,
      source: {
        type: "snapshot",
        snapshotId: "snap_rebuilt",
      },
    });
  });

  it("starts a build when a Workspace has no ready snapshot", async () => {
    getReadyWorkspaceMock.mockRejectedValueOnce(
      new WorkspaceSnapshotNotReadyError("snapshot-not-ready"),
    );
    const workspace = {
      id: "workspace-snapshot-not-ready",
      name: "snapshot-not-ready",
      setupScript: "",
      snapshot: null,
      repos: [],
    };
    const runtime = createSandboxRuntime({
      workspace,
      skills: [],
      referenceFiles: [],
    });

    await expect(runtime.acquire()).rejects.toSatisfy(
      isWorkspaceSnapshotNotReadyError,
    );

    expect(ensureWorkspaceSnapshotBuildMock).toHaveBeenCalledWith({ workspace });
    expect(sandboxCreateMock).not.toHaveBeenCalled();
  });

  it("starts a new build when a Workspace snapshot is missing", async () => {
    getReadyWorkspaceMock
      .mockResolvedValueOnce({
        snapshotId: "snap_workspace_missing",
        profileHash: "hash_workspace",
        dependencyCount: 2,
        cacheHit: true,
        resolveOutcome: "cache_hit",
      })
      .mockRejectedValueOnce(
        new WorkspaceSnapshotNotReadyError("missing-snapshot"),
      );
    const missingError = new Error("Workspace snapshot not found");
    sandboxCreateMock.mockRejectedValueOnce(missingError);
    missingErrorMock.mockImplementation(
      (error: unknown) => error === missingError,
    );
    hashMock.mockReturnValue("hash_workspace");
    const runtime = createSandboxRuntime({
      workspace: {
        id: "workspace-missing-snapshot",
        name: "missing-snapshot",
        setupScript: "",
        snapshot: null,
        repos: [],
      },
      skills: [],
      referenceFiles: [],
    });

    await expect(runtime.acquire()).rejects.toSatisfy(
      isWorkspaceSnapshotNotReadyError,
    );

    expect(getReadyWorkspaceMock).toHaveBeenCalledTimes(2);
    expect(getReadyWorkspaceMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        runtime: "node22",
        staleSnapshotId: "snap_workspace_missing",
        workspace: expect.objectContaining({
          id: "workspace-missing-snapshot",
        }),
      }),
    );
    expect(ensureWorkspaceSnapshotBuildMock).toHaveBeenCalledWith({
      workspace: expect.objectContaining({ id: "workspace-missing-snapshot" }),
    });
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("retries snapshot boot when Vercel reports snapshotting in progress", async () => {
    const snapshotSandbox = makeSandbox("sbx_snapshot_ready");
    resolveMock.mockResolvedValue({
      snapshotId: "snap_retry",
      profileHash: "hash_retry",
      dependencyCount: 2,
      cacheHit: true,
      resolveOutcome: "cache_hit",
    });
    const snapshottingError = createApiError(
      422,
      "Unprocessable Entity",
      "sandbox_snapshotting",
      "Sandbox is creating a snapshot and will be stopped shortly.",
    );
    sandboxCreateMock
      .mockRejectedValueOnce(snapshottingError)
      .mockResolvedValueOnce(snapshotSandbox);

    const executor = createTestSandbox();
    executor.configureSkills([]);

    const sandbox = await executor.createSandbox();

    await expectWorkspaceToDelegate(sandbox, snapshotSandbox);
    expect(sandboxCreateMock).toHaveBeenCalledTimes(2);
    expect(sandboxCreateMock).toHaveBeenNthCalledWith(1, {
      timeout: 1000 * 60 * 30,
      source: {
        type: "snapshot",
        snapshotId: "snap_retry",
      },
    });
    expect(sandboxCreateMock).toHaveBeenNthCalledWith(2, {
      timeout: 1000 * 60 * 30,
      source: {
        type: "snapshot",
        snapshotId: "snap_retry",
      },
    });
  });

  it("uses a fresh sandbox name when retrying snapshot boot with network policy", async () => {
    const snapshotSandbox = makeSandbox("sbx_snapshot_policy_ready");
    resolveMock.mockResolvedValue({
      snapshotId: "snap_policy_retry",
      profileHash: "hash_policy_retry",
      dependencyCount: 2,
      cacheHit: true,
      resolveOutcome: "cache_hit",
    });
    const snapshottingError = createApiError(
      422,
      "Unprocessable Entity",
      "sandbox_snapshotting",
      "Sandbox is creating a snapshot and will be stopped shortly.",
    );
    sandboxCreateMock
      .mockRejectedValueOnce(snapshottingError)
      .mockResolvedValueOnce(snapshotSandbox);
    const createNetworkPolicy = vi.fn((sandboxId: string) => ({
      allow: {
        "*": [],
        "api.example.com": [
          {
            forwardURL: `https://junior.example.com/api/internal/sandbox-egress/${sandboxId}`,
          },
        ],
      },
    }));

    const manager = createTestSandboxRuntime({ createNetworkPolicy });
    manager.configureSkills([]);

    await manager.createSandbox();

    const firstCreate = sandboxCreateMock.mock.calls[0]?.[0] as {
      name?: string;
      networkPolicy?: unknown;
    };
    const secondCreate = sandboxCreateMock.mock.calls[1]?.[0] as {
      name?: string;
      networkPolicy?: unknown;
    };
    expect(firstCreate.name).toMatch(/^junior-/);
    expect(secondCreate.name).toMatch(/^junior-/);
    expect(secondCreate.name).not.toBe(firstCreate.name);
    expect(createNetworkPolicy).toHaveBeenNthCalledWith(1, firstCreate.name);
    expect(createNetworkPolicy).toHaveBeenNthCalledWith(2, secondCreate.name);
    expect(createNetworkPolicy).toHaveBeenNthCalledWith(
      3,
      "sbx_snapshot_policy_ready_session",
      undefined,
    );
    expect(secondCreate.networkPolicy).toEqual({
      allow: {
        "*": [],
        "api.example.com": [
          {
            forwardURL: `https://junior.example.com/api/internal/sandbox-egress/${secondCreate.name}`,
          },
        ],
      },
    });
    expect(snapshotSandbox.update).toHaveBeenCalledWith({
      networkPolicy: {
        allow: {
          "*": [],
          "api.example.com": [
            {
              forwardURL:
                "https://junior.example.com/api/internal/sandbox-egress/sbx_snapshot_policy_ready_session",
            },
          ],
        },
      },
    });
  });

  it("wraps snapshot resolution failures as sandbox setup errors", async () => {
    resolveMock.mockRejectedValueOnce(new Error("lock timeout"));

    const executor = createTestSandbox();
    executor.configureSkills([]);

    await expect(executor.createSandbox()).rejects.toThrow(
      "sandbox setup failed",
    );
    expect(sandboxCreateMock).not.toHaveBeenCalled();
  });
});
