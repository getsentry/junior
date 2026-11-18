import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import * as z from "zod";
import {
  DockerApiError,
  dockerOkStream,
  dockerRequest,
  type DockerRequest,
} from "@/core/tool-execution-environment/docker/api";
import {
  packTar,
  streamFirstFile,
} from "@/core/tool-execution-environment/docker/tar";
import {
  ToolExecutionEnvironmentUnavailableError,
  type CreateToolExecutionEnvironmentInput,
  type ExecOptions,
  type ExecResult,
  type OutputChunk,
  type ToolExecutionEnvironment,
  type ToolExecutionEnvironmentManager,
} from "@/core/tool-execution-environment/types";
import { toWebStream } from "@/core/tool-execution-environment/web-stream";

const WORKSPACE = "/workspace";
/** Marks every container this manager creates, so they can be found. */
const LABEL = "dev.junior.tool-execution-environment";
const EXIT_POLL_MS = 50;
const KILL_TIMEOUT_MS = 10_000;

const containerSchema = z.object({
  State: z.object({ Running: z.boolean(), StartedAt: z.string() }),
});
const idSchema = z.object({ Id: z.string() });
const execStateSchema = z.object({
  Running: z.boolean(),
  ExitCode: z.number().nullable(),
});
const pullErrorSchema = z.object({ error: z.string() });

type Container = z.infer<typeof containerSchema>;

/**
 * Manages containers on the local Docker daemon. The environment id is the
 * container name. `image` must include a tag, and `snapshotId` is an image
 * to start from instead. Commands run as the image's user.
 *
 * At its timeout a container stops and keeps its files, so `resume` starts
 * it again with them, like a persistent Vercel Sandbox.
 */
export function createDockerToolExecutionEnvironmentManager(options: {
  image: string;
}): ToolExecutionEnvironmentManager {
  return {
    async create(input, signal) {
      const image = input.snapshotId ?? options.image;
      try {
        await createContainer(input, image, signal);
      } catch (error) {
        if (isStatus(error, 404)) {
          await pullImage(image, signal);
          await createContainer(input, image, signal);
        } else if (!isStatus(error, 409)) {
          // 409 means a container with this name exists: a retried create.
          throw error;
        }
      }
      const environment = await resume(input.id, signal);
      if (!environment) {
        throw new Error(`Docker container ${input.id} is gone after create`);
      }
      return environment;
    },
    resume,
  };
}

async function resume(
  id: string,
  signal: AbortSignal,
): Promise<ToolExecutionEnvironment | undefined> {
  let container = await inspect(id, signal);
  if (!container) return undefined;
  if (!container.State.Running) {
    try {
      await dockerRequest({
        method: "POST",
        path: `/containers/${id}/start`,
        signal,
      });
    } catch (error) {
      // 304 means another caller started it first.
      if (!isStatus(error, 304)) throw error;
    }
    container = await inspect(id, signal);
    if (!container?.State.Running) {
      throw new Error(`Docker container ${id} did not start`);
    }
  }
  return toEnvironment(id, container.State.StartedAt);
}

async function createContainer(
  input: CreateToolExecutionEnvironmentInput,
  image: string,
  signal: AbortSignal,
): Promise<void> {
  await dockerRequest({
    method: "POST",
    path: "/containers/create",
    query: { name: input.id },
    body: {
      Image: image,
      // The container stops when this ends. `docker start` runs it again,
      // which gives a resumed container a full timeout.
      Entrypoint: ["sleep"],
      Cmd: [String(Math.ceil(input.timeoutMs / 1000))],
      WorkingDir: WORKSPACE,
      Labels: { [LABEL]: input.id },
      // docker-init reaps killed processes, so none are left as zombies.
      HostConfig: { Init: true },
    },
    signal,
  });
}

async function pullImage(image: string, signal: AbortSignal): Promise<void> {
  const body = await dockerRequest({
    method: "POST",
    path: "/images/create",
    query: { fromImage: image },
    signal,
  });
  // A failed pull still returns 200, with the error in the progress lines.
  for (const line of body.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    const failed = pullErrorSchema.safeParse(JSON.parse(line));
    if (failed.success) {
      throw new Error(`Could not pull ${image}: ${failed.data.error}`);
    }
  }
}

// Bound to one start of the container: a restart loses running processes,
// so the caller must see it and call `resume`.
function toEnvironment(
  id: string,
  startedAt: string,
): ToolExecutionEnvironment {
  const resolve = (filePath: string) => path.posix.resolve(WORKSPACE, filePath);
  return {
    cwd: WORKSPACE,
    exec: (argv, options) =>
      callOrThrowUnavailable(id, startedAt, () => exec(id, argv, options)),
    readFile: (filePath, signal) =>
      callOrThrowUnavailable(id, startedAt, () =>
        readFile(id, resolve(filePath), signal),
      ),
    writeFile: (filePath, content, signal) =>
      callOrThrowUnavailable(id, startedAt, () =>
        writeFile(id, resolve(filePath), content, signal),
      ),
  };
}

// Callers own the lifecycle, so a stopped or restarted container becomes the
// one provider-neutral error that tells them to resume.
async function callOrThrowUnavailable<T>(
  id: string,
  startedAt: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!(await isSameStart(id, startedAt))) {
    throw new ToolExecutionEnvironmentUnavailableError(id);
  }
  try {
    return await operation();
  } catch (error) {
    if (!(await isSameStart(id, startedAt))) {
      throw new ToolExecutionEnvironmentUnavailableError(id, { cause: error });
    }
    throw error;
  }
}

async function isSameStart(id: string, startedAt: string): Promise<boolean> {
  const container = await inspect(id);
  return (
    container?.State.Running === true && container.State.StartedAt === startedAt
  );
}

async function exec(
  id: string,
  argv: readonly string[],
  options: ExecOptions,
): Promise<ExecResult> {
  if (argv.length === 0) throw new TypeError("argv is empty");

  const signal =
    options.timeoutMs === undefined
      ? options.signal
      : AbortSignal.any([
          options.signal,
          AbortSignal.timeout(options.timeoutMs),
        ]);
  signal.throwIfAborted();

  // Docker cannot kill an exec. Each exec is its own process group, so the
  // wrapper saves the group id, and an abort kills the group. `"$@"` passes
  // argv on unchanged, so the shell never parses it.
  const groupFile = `/tmp/junior-exec-${randomUUID()}`;
  const created = await requestJson(
    {
      method: "POST",
      path: `/containers/${id}/exec`,
      body: {
        AttachStdout: true,
        AttachStderr: true,
        Cmd: [
          "sh",
          "-c",
          `echo $$ > ${groupFile}; "$@"; status=$?; rm -f ${groupFile}; exit $status`,
          "sh",
          ...argv,
        ],
        WorkingDir: options.cwd ?? WORKSPACE,
        Env: Object.entries(options.env ?? {}).map(
          ([name, value]) => `${name}=${value}`,
        ),
      },
      signal,
    },
    idSchema,
  );

  try {
    const stream = await dockerOkStream({
      method: "POST",
      path: `/exec/${created.Id}/start`,
      body: { Detach: false, Tty: false },
      signal,
    });
    await forwardOutput(stream, options.onOutputChunk);
    return { exitCode: await exitCodeOf(created.Id, signal) };
  } catch (error) {
    if (!signal.aborted) throw error;
    await exec(
      id,
      [
        "sh",
        "-c",
        `[ -f ${groupFile} ] && kill -9 -"$(cat ${groupFile})"; rm -f ${groupFile}; true`,
      ],
      { signal: AbortSignal.timeout(KILL_TIMEOUT_MS), onOutputChunk: () => {} },
    );
    throw signal.reason;
  }
}

// Docker sends both streams on one connection, each frame behind an 8-byte
// header: the stream (1 or 2), three zero bytes, and the frame length.
async function forwardOutput(
  stream: Readable,
  onOutputChunk: (chunk: OutputChunk) => void,
): Promise<void> {
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    pending = Buffer.concat([
      pending,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
    ]);
    while (pending.length >= 8) {
      const size = pending.readUInt32BE(4);
      if (pending.length < 8 + size) break;
      const name = pending[0] === 2 ? "stderr" : "stdout";
      const text = decoders[name].decode(pending.subarray(8, 8 + size), {
        stream: true,
      });
      if (text) onOutputChunk({ stream: name, text });
      pending = pending.subarray(8 + size);
    }
  }
  for (const name of ["stdout", "stderr"] as const) {
    const text = decoders[name].decode();
    if (text) onOutputChunk({ stream: name, text });
  }
}

// Docker sets the exit code shortly after the output ends.
async function exitCodeOf(
  execId: string,
  signal: AbortSignal,
): Promise<number> {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- Poll until the exec ends.
    const state = await requestJson(
      { path: `/exec/${execId}/json`, signal },
      execStateSchema,
    );
    if (!state.Running && state.ExitCode !== null) return state.ExitCode;
    // oxlint-disable-next-line no-await-in-loop -- Wait before the next check.
    await sleep(EXIT_POLL_MS, undefined, { signal });
  }
}

async function readFile(
  id: string,
  filePath: string,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array> | undefined> {
  try {
    const archive = await dockerOkStream({
      path: `/containers/${id}/archive`,
      query: { path: filePath },
      signal,
    });
    return toWebStream(streamFirstFile(archive));
  } catch (error) {
    if (isStatus(error, 404)) return undefined;
    throw error;
  }
}

// Docker creates missing parent directories when it unpacks the archive.
// copyUIDGID gives the file to the image's user.
async function writeFile(
  id: string,
  filePath: string,
  content: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  await dockerRequest({
    method: "PUT",
    path: `/containers/${id}/archive`,
    query: { path: "/", copyUIDGID: true },
    body: packTar([
      { path: filePath.slice(1), content, mode: 0o644, uid: 0, gid: 0 },
    ]),
    signal,
  });
}

async function inspect(
  id: string,
  signal?: AbortSignal,
): Promise<Container | undefined> {
  try {
    return await requestJson(
      { path: `/containers/${id}/json`, signal },
      containerSchema,
    );
  } catch (error) {
    if (isStatus(error, 404)) return undefined;
    throw error;
  }
}

async function requestJson<T>(
  input: DockerRequest,
  schema: z.ZodType<T>,
): Promise<T> {
  const body = await dockerRequest(input);
  return schema.parse(JSON.parse(body.toString("utf8")));
}

function isStatus(error: unknown, statusCode: number): boolean {
  return error instanceof DockerApiError && error.statusCode === statusCode;
}
