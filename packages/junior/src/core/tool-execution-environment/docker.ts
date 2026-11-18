import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as z from "zod";
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
    const stream = await openStream({
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
  stream: AsyncIterable<unknown>,
  onOutputChunk: (chunk: OutputChunk) => void,
): Promise<void> {
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    pending = Buffer.concat([pending, toBuffer(chunk)]);
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
    const archive = await openStream({
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
    body: tarFile(filePath.slice(1), content),
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

// The Docker Engine API over the local unix socket. It uses `node:http`, so
// Docker needs no SDK.

const API_VERSION = "v1.43";

class DockerApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(`Docker API error status=${statusCode}: ${message}`);
    this.name = "DockerApiError";
    this.statusCode = statusCode;
  }
}

type DockerRequest = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean>;
  /** JSON body, or a tar archive. */
  body?: unknown;
  signal?: AbortSignal;
};

const errorBodySchema = z.object({ message: z.string() });

// Returns the response stream. An error status throws DockerApiError.
async function openStream(input: DockerRequest): Promise<http.IncomingMessage> {
  input.signal?.throwIfAborted();
  const raw =
    input.body instanceof Uint8Array ? Buffer.from(input.body) : undefined;
  const json =
    input.body !== undefined && !raw ? JSON.stringify(input.body) : undefined;
  const response = await new Promise<http.IncomingMessage>(
    (resolve, reject) => {
      const request = http.request({
        socketPath: socketPath(),
        // The daemon closes idle connections. A reused keep-alive socket then
        // fails with EPIPE, so each request opens its own connection.
        agent: false,
        path: requestPath(input),
        method: input.method ?? "GET",
        headers: {
          ...(json ? { "content-type": "application/json" } : undefined),
          ...(raw ? { "content-type": "application/x-tar" } : undefined),
        },
        signal: input.signal,
      });
      request.on("response", resolve);
      request.on("error", reject);
      request.end(raw ?? json);
    },
  );
  const statusCode = response.statusCode ?? 0;
  if (statusCode < 400) return response;

  const body = (await readAll(response)).toString("utf8");
  let message = body.trim() || response.statusMessage || "request failed";
  try {
    const parsed = errorBodySchema.safeParse(JSON.parse(body));
    if (parsed.success) message = parsed.data.message;
  } catch {
    // Keep the raw body as the message.
  }
  throw new DockerApiError(statusCode, message);
}

async function dockerRequest(input: DockerRequest): Promise<Buffer> {
  return await readAll(await openStream(input));
}

function socketPath(): string {
  const host = process.env["DOCKER_HOST"]?.trim();
  if (!host) return "/var/run/docker.sock";
  if (!host.startsWith("unix://")) {
    throw new Error(
      `The Docker manager supports only unix sockets. DOCKER_HOST is ${host}`,
    );
  }
  return host.slice("unix://".length);
}

function requestPath(input: DockerRequest): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input.query ?? {})) {
    params.set(key, String(value));
  }
  const query = params.toString();
  return `/${API_VERSION}${input.path}${query ? `?${query}` : ""}`;
}

async function readAll(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(toBuffer(chunk));
  return Buffer.concat(chunks);
}

// Node types stream chunks as `any`. Docker streams yield Buffers.
function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

// The small part of the tar format that Docker's archive API needs.

const TAR_BLOCK = 512;

// One regular file as an uncompressed archive. Its owner is set by
// copyUIDGID, so the header says root. A path longer than the 100-byte name
// field goes in a PAX header.
function tarFile(filePath: string, content: Uint8Array): Buffer {
  const parts: Buffer[] = [];
  let name = filePath;
  if (Buffer.byteLength(name) > 99) {
    const pax = paxRecord("path", name);
    parts.push(
      tarHeader("PaxHeader", pax.length, "x"),
      pax,
      tarPadding(pax.length),
    );
    name = name.slice(-99);
  }
  parts.push(
    tarHeader(name, content.length, "0"),
    Buffer.from(content),
    tarPadding(content.length),
    Buffer.alloc(TAR_BLOCK * 2),
  );
  return Buffer.concat(parts);
}

function tarHeader(name: string, size: number, type: string): Buffer {
  const block = Buffer.alloc(TAR_BLOCK);
  writeString(block, name, 0, 100);
  writeOctal(block, 0o644, 100, 8);
  writeOctal(block, 0, 108, 8);
  writeOctal(block, 0, 116, 8);
  writeOctal(block, size, 124, 12);
  writeOctal(block, Math.floor(Date.now() / 1000), 136, 12);
  block.fill(" ", 148, 156);
  writeString(block, type, 156, 1);
  writeString(block, "ustar\0", 257, 6);
  writeString(block, "00", 263, 2);
  let checksum = 0;
  for (const byte of block) checksum += byte;
  writeString(block, `${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

function writeString(
  block: Buffer,
  value: string,
  offset: number,
  length: number,
): void {
  block.write(value, offset, Math.min(Buffer.byteLength(value), length));
}

function writeOctal(
  block: Buffer,
  value: number,
  offset: number,
  length: number,
): void {
  writeString(
    block,
    `${value.toString(8).padStart(length - 1, "0")}\0`,
    offset,
    length,
  );
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const text = block
    .subarray(offset, offset + length)
    .toString("ascii")
    .replace(/\0.*$/s, "")
    .trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function tarPadding(size: number): Buffer {
  const remainder = size % TAR_BLOCK;
  return Buffer.alloc(remainder === 0 ? 0 : TAR_BLOCK - remainder);
}

/** A PAX record such as `30 path=some/long/name\n`. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body);
  length += String(length).length;
  if (String(length).length !== String(length - 1).length) length += 1;
  return Buffer.from(`${length}${body}`);
}

/**
 * Yields the content of the first entry in a tar stream as it arrives, so a
 * large file is never held in memory. Throws when that entry is not a regular
 * file. Ending the iteration early closes the archive stream.
 */
async function* streamFirstFile(
  archive: AsyncIterable<unknown>,
): AsyncGenerator<Uint8Array> {
  const chunks = archive[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);

  async function fill(length: number): Promise<void> {
    while (buffered.length < length) {
      // oxlint-disable-next-line no-await-in-loop -- Each chunk depends on the stream position.
      const next = await chunks.next();
      if (next.done) throw new Error("The tar archive ended early");
      buffered = Buffer.concat([buffered, toBuffer(next.value)]);
    }
  }

  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- Headers are read in order.
      await fill(TAR_BLOCK);
      const block = buffered.subarray(0, TAR_BLOCK);
      buffered = buffered.subarray(TAR_BLOCK);
      if (block.every((byte) => byte === 0)) {
        throw new Error("The tar archive has no entries");
      }
      const size = readOctal(block, 124, 12);
      const type = String.fromCharCode(block[156] ?? 0);
      // Extended headers describe the next entry. Skip them.
      if (type === "x" || type === "g" || type === "L") {
        const skipped = size + tarPadding(size).length;
        // oxlint-disable-next-line no-await-in-loop -- Headers are read in order.
        await fill(skipped);
        buffered = buffered.subarray(skipped);
        continue;
      }
      if (type !== "0" && type !== "\0") {
        throw new Error(`The path is not a regular file (tar type ${type})`);
      }
      let remaining = size;
      while (remaining > 0) {
        // oxlint-disable-next-line no-await-in-loop -- Content is read in order.
        if (buffered.length === 0) await fill(1);
        const part = buffered.subarray(0, remaining);
        buffered = buffered.subarray(part.length);
        remaining -= part.length;
        yield part;
      }
      return;
    }
  } finally {
    await chunks.return?.();
  }
}
