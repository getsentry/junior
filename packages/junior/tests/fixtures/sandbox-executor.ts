import { expect, vi } from "vitest";
import { SANDBOX_EGRESS_PROXY_PATH } from "@/chat/sandbox/egress-session";
import type { SandboxInstance } from "@/chat/sandbox/workspace";

export interface MockSandbox {
  name: string;
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

/** Build a Vercel Sandbox-shaped fake with overridable setup failures. */
export function makeSandbox(
  name: string,
  options: {
    mkDirError?: unknown;
    writeFilesError?: unknown;
  } = {},
): MockSandbox {
  return {
    name,
    currentSession: vi.fn(() => ({ sessionId: `${name}_session` })),
    fs: {
      readFile: vi.fn(async () => ""),
      writeFile: vi.fn(async () => {}),
      readdir: vi.fn(async () => []),
      stat: vi.fn(async () => ({ isDirectory: () => false })),
    },
    mkDir: vi.fn(async () => {
      if (options.mkDirError) {
        throw options.mkDirError;
      }
    }),
    writeFiles: vi.fn(async () => {
      if (options.writeFilesError) {
        throw options.writeFilesError;
      }
    }),
    readFileToBuffer: vi.fn(async () => Buffer.from("")),
    runCommand: vi.fn(async () => ({
      exitCode: 0,
      stdout: async () => "",
      stderr: async () => "",
    })),
    stop: vi.fn(async () => {}),
    extendTimeout: vi.fn(async () => {}),
    snapshot: vi.fn(async () => ({ snapshotId: "snap_test" })),
    update: vi.fn(async () => {}),
  };
}

/** Extract the Sentry forward URL from a sandbox network policy fixture. */
export function sentryForwardURLFromPolicy(
  policy: unknown,
): string | undefined {
  const allow = (
    policy as { allow?: Record<string, Array<{ forwardURL?: string }>> }
  ).allow;
  return allow?.["sentry.io"]?.[0]?.forwardURL;
}

/** Extract the egress credential token from a sandbox proxy forward URL. */
export function credentialTokenFromForwardURL(
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

/** Build a Vercel-style API error object for sandbox setup tests. */
export function createApiError(
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

/** Build an error shaped like an interrupted sandbox command stream. */
export function createStreamInterruptedError(): Error {
  return Object.assign(new Error("Stream ended before command finished"), {
    name: "StreamError",
  });
}

/** Assert that a SandboxInstance delegates file and command calls to the fake. */
export async function expectWorkspaceToDelegate(
  workspace: SandboxInstance,
  sandbox: MockSandbox,
): Promise<void> {
  expect(workspace.sandboxId).toBe(sandbox.name);
  expect(workspace.sandboxEgressId).toBe(`${sandbox.name}_session`);
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
  await expect(
    workspace.runCommand({ cmd: "pwd", args: ["-P"], cwd: "/tmp" }),
  ).resolves.toBe(commandResult);
  expect(sandbox.runCommand).toHaveBeenCalledWith({
    cmd: "pwd",
    args: ["-P"],
    cwd: "/tmp",
  });
}
