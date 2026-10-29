import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { dockerJson, dockerOkStream } from "@/chat/sandbox/docker/api";
import { sleep } from "@/chat/sleep";
import type {
  SandboxCommandInput,
  SandboxCommandResult,
} from "@/chat/sandbox/workspace";

// Module overview: run commands in a sandbox container with Docker exec.
//
// Docker cannot kill an exec instance. So every command runs in its own
// process group and writes its group id to a file. Abort kills that group
// with a second exec.

/** Directory for command state in each sandbox. The runtime image creates it. */
export const COMMAND_STATE_DIR = "/var/tmp/junior-commands";
/** User for commands without `sudo`. It matches Vercel Sandbox. */
export const SANDBOX_USER = "vercel-sandbox";
const KILL_GRACE_MS = 2_000;
const EXIT_POLL_MS = 250;

interface ExecInspect {
  ExitCode: number | null;
  Running: boolean;
}

function timeoutArgs(timeoutMs: number | undefined): string[] {
  if (!timeoutMs || timeoutMs <= 0) return [];
  return ["timeout", "-k", "5", `${Math.ceil(timeoutMs / 1000)}s`];
}

function envList(env: Record<string, string> | undefined): string[] {
  return Object.entries(env ?? {}).map(([key, value]) => `${key}=${value}`);
}

async function createExec(
  containerId: string,
  input: {
    cmd: string[];
    cwd?: string;
    env?: Record<string, string>;
    root?: boolean;
    attach: boolean;
  },
  signal?: AbortSignal,
): Promise<string> {
  const created = await dockerJson<{ Id: string }>({
    method: "POST",
    path: `/containers/${encodeURIComponent(containerId)}/exec`,
    body: {
      AttachStdout: input.attach,
      AttachStderr: input.attach,
      Cmd: input.cmd,
      Env: envList(input.env),
      User: input.root ? "root" : SANDBOX_USER,
      ...(input.cwd ? { WorkingDir: input.cwd } : undefined),
    },
    signal,
  });
  return created.Id;
}

/** Split Docker's multiplexed exec stream into stdout and stderr. */
async function demux(
  stream: Readable,
): Promise<{ stdout: string; stderr: string }> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    pending = Buffer.concat([
      pending,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    ]);
    while (pending.length >= 8) {
      const size = pending.readUInt32BE(4);
      if (pending.length < 8 + size) break;
      const frame = pending.subarray(8, 8 + size);
      if (pending[0] === 2) stderr.push(frame);
      else stdout.push(frame);
      pending = pending.subarray(8 + size);
    }
  }
  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

async function waitForExit(execId: string): Promise<number> {
  for (;;) {
    const inspect = await dockerJson<ExecInspect>({
      path: `/exec/${execId}/json`,
    });
    if (!inspect.Running) return inspect.ExitCode ?? -1;
    await sleep(EXIT_POLL_MS);
  }
}

async function killGroup(
  containerId: string,
  id: string,
  signalName: "TERM" | "KILL",
) {
  const pidFile = `${COMMAND_STATE_DIR}/${id}.pid`;
  await runRawExec(containerId, {
    cmd: [
      "sh",
      "-c",
      `[ -f ${pidFile} ] && kill -${signalName} -- -"$(cat ${pidFile})" 2>/dev/null; true`,
    ],
    root: true,
  });
}

/** Run one exec without the process-group wrapper. Used for internal steps. */
export async function runRawExec(
  containerId: string,
  input: {
    cmd: string[];
    cwd?: string;
    env?: Record<string, string>;
    root?: boolean;
  },
  signal?: AbortSignal,
): Promise<SandboxCommandResult> {
  const execId = await createExec(
    containerId,
    { ...input, attach: true },
    signal,
  );
  const stream = await dockerOkStream({
    method: "POST",
    path: `/exec/${execId}/start`,
    body: { Detach: false, Tty: false },
    signal,
  });
  const output = await demux(stream);
  return { exitCode: await waitForExit(execId), ...output };
}

/** Run one command in a sandbox container. Abort kills its process group. */
export async function runSandboxCommand(
  containerId: string,
  input: SandboxCommandInput,
): Promise<SandboxCommandResult> {
  input.signal?.throwIfAborted();
  const id = randomUUID();
  const pidFile = `${COMMAND_STATE_DIR}/${id}.pid`;
  const execId = await createExec(containerId, {
    cmd: [
      "setsid",
      "-w",
      "sh",
      "-c",
      `echo $$ > ${pidFile}; exec "$@"`,
      "sh",
      ...timeoutArgs(input.timeoutMs),
      input.cmd,
      ...(input.args ?? []),
    ],
    cwd: input.cwd,
    env: input.env,
    root: input.sudo,
    attach: true,
  });
  // The exec keeps running after this request is aborted, so the stream is
  // not bound to the signal. Abort kills the process group instead.
  const stream = await dockerOkStream({
    method: "POST",
    path: `/exec/${execId}/start`,
    body: { Detach: false, Tty: false },
  });
  const signal = input.signal;
  const onAbort = () => {
    void (async () => {
      await killGroup(containerId, id, "TERM");
      await sleep(KILL_GRACE_MS);
      await killGroup(containerId, id, "KILL");
    })().catch(() => {
      // The container may already be gone.
    });
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const output = await demux(stream);
    signal?.throwIfAborted();
    return { exitCode: await waitForExit(execId), ...output };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    void runRawExec(containerId, {
      cmd: ["rm", "-f", pidFile],
      root: true,
    }).catch(() => {
      // Best-effort cleanup.
    });
  }
}

/** Start a command that keeps running after this request. Return its id. */
export async function startDetachedCommand(
  containerId: string,
  input: SandboxCommandInput,
): Promise<string> {
  const id = randomUUID();
  const dir = `${COMMAND_STATE_DIR}/${id}`;
  const execId = await createExec(
    containerId,
    {
      cmd: [
        "sh",
        "-c",
        [
          `mkdir -p ${dir}`,
          `"$@" >${dir}/stdout 2>${dir}/stderr`,
          `echo $? >${dir}/exit.tmp`,
          `mv ${dir}/exit.tmp ${dir}/exit`,
        ].join("; "),
        "sh",
        ...timeoutArgs(input.timeoutMs),
        input.cmd,
        ...(input.args ?? []),
      ],
      cwd: input.cwd,
      env: input.env,
      root: input.sudo,
      attach: false,
    },
    input.signal,
  );
  await dockerJson({
    method: "POST",
    path: `/exec/${execId}/start`,
    body: { Detach: true, Tty: false },
    signal: input.signal,
  });
  return id;
}

async function readCommandFile(
  containerId: string,
  id: string,
  name: "exit" | "stdout" | "stderr",
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await runRawExec(
    containerId,
    { cmd: ["cat", `${COMMAND_STATE_DIR}/${id}/${name}`], root: true },
    signal,
  );
  return result.exitCode === 0 ? result.stdout : null;
}

/**
 * Wait until a detached command writes its exit code.
 *
 * The state lives in files in the container, so any process can wait for a
 * command that another process started.
 */
export async function waitForDetachedCommand(
  containerId: string,
  id: string,
  signal: AbortSignal,
): Promise<{
  exitCode: number;
  stdout(): Promise<string>;
  stderr(): Promise<string>;
}> {
  for (;;) {
    signal.throwIfAborted();
    const exit = await readCommandFile(containerId, id, "exit", signal);
    if (exit !== null) {
      return {
        exitCode: Number.parseInt(exit.trim(), 10),
        stdout: async () =>
          (await readCommandFile(containerId, id, "stdout")) ?? "",
        stderr: async () =>
          (await readCommandFile(containerId, id, "stderr")) ?? "",
      };
    }
    await sleep(EXIT_POLL_MS, signal);
  }
}
