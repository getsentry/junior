import { APIError, Sandbox, StreamError } from "@vercel/sandbox";
import type { Command, Session } from "@vercel/sandbox";
import * as z from "zod";
import {
  ToolExecutionEnvironmentUnavailableError,
  type CreateToolExecutionEnvironmentInput,
  type ExecOptions,
  type ExecResult,
  type ToolExecutionEnvironment,
  type ToolExecutionEnvironmentManager,
} from "@/core/tool-execution-environment/types";
import { setActiveSpanAttributes } from "@/core/telemetry";

// Vercel enforces this after our own timer, so a command still stops when
// this process dies, but our timer fires first and the call throws.
const VERCEL_TIMEOUT_BACKSTOP_MS = 5_000;

/**
 * Manages Vercel Sandboxes. The environment id is the sandbox name. Sandboxes
 * are persistent, so `resume` gets the files back after a stop.
 */
export function createVercelToolExecutionEnvironmentManager(): ToolExecutionEnvironmentManager {
  return {
    async create(input: CreateToolExecutionEnvironmentInput, signal) {
      const params = {
        name: input.id,
        persistent: true,
        timeout: input.timeoutMs,
        resume: true,
        signal,
      };
      // getOrCreate makes a retried create with the same id safe.
      const sandbox = await Sandbox.getOrCreate(
        input.snapshotId
          ? {
              ...params,
              source: { type: "snapshot", snapshotId: input.snapshotId },
            }
          : params,
      );
      return toEnvironment(input.id, sandbox.currentSession());
    },

    async resume(id, signal) {
      try {
        const sandbox = await Sandbox.get({ name: id, resume: true, signal });
        return toEnvironment(id, sandbox.currentSession());
      } catch (error) {
        if (error instanceof APIError && error.response.status === 404) {
          return undefined;
        }
        throw error;
      }
    },
  };
}

// Bound to one session, not to the Sandbox: the Sandbox object starts a
// stopped session again by itself, and a restart must be visible to the
// caller because it loses running processes.
function toEnvironment(id: string, session: Session): ToolExecutionEnvironment {
  // Lets a trace be matched to the Vercel session that ran it.
  setActiveSpanAttributes({ "app.sandbox.session_id": session.sessionId });
  return {
    cwd: session.cwd,
    exec: (argv, options) =>
      callOrThrowUnavailable(id, () => exec(session, argv, options)),
    readFile: (path, signal) =>
      callOrThrowUnavailable(id, () => readFile(session, path, signal)),
    writeFile: (path, content, signal) =>
      callOrThrowUnavailable(id, () =>
        session.writeFiles([{ path, content }], { signal }),
      ),
  };
}

// Callers own the lifecycle and must not import the Vercel SDK, so a stopped
// session becomes the one provider-neutral error that tells them to resume.
async function callOrThrowUnavailable<T>(
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isStopped(error)) {
      throw new ToolExecutionEnvironmentUnavailableError(id, { cause: error });
    }
    throw error;
  }
}

async function readFile(
  session: Session,
  path: string,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array> | undefined> {
  const stream = await session.readFile({ path }, { signal });
  return stream ? toWebStream(stream) : undefined;
}

async function exec(
  session: Session,
  argv: readonly string[],
  options: ExecOptions,
): Promise<ExecResult> {
  const [cmd, ...args] = argv;
  if (cmd === undefined) throw new TypeError("argv is empty");

  const signal =
    options.timeoutMs === undefined
      ? options.signal
      : AbortSignal.any([
          options.signal,
          AbortSignal.timeout(options.timeoutMs),
        ]);
  signal.throwIfAborted();

  const command = await session.runCommand({
    cmd,
    args,
    cwd: options.cwd,
    env: options.env,
    detached: true,
    timeoutMs:
      options.timeoutMs === undefined
        ? undefined
        : options.timeoutMs + VERCEL_TIMEOUT_BACKSTOP_MS,
  });

  try {
    const [, finished] = await Promise.all([
      forwardOutput(command, signal, options.onOutputChunk),
      command.wait({ signal }),
    ]);
    return { exitCode: finished.exitCode };
  } catch (error) {
    if (!signal.aborted) throw error;
    await command.kill("SIGKILL");
    throw signal.reason;
  }
}

async function forwardOutput(
  command: Command,
  signal: AbortSignal,
  onOutputChunk: ExecOptions["onOutputChunk"],
): Promise<void> {
  for await (const line of command.logs({ signal })) {
    onOutputChunk({ stream: line.stream, text: line.data });
  }
}

const apiErrorBody = z.object({ error: z.object({ code: z.string() }) });

// The same checks the SDK uses before it restarts a session by itself
// (`withResume` in @vercel/sandbox). A StreamError means the session stopped
// while output was streaming.
function isStopped(error: unknown): boolean {
  if (error instanceof StreamError) return true;
  if (!(error instanceof APIError)) return false;
  if (error.response.status === 410) return true;
  const code = apiErrorBody.safeParse(error.json).data?.error.code;
  return (
    error.response.status === 422 &&
    (code === "sandbox_stopping" || code === "sandbox_snapshotting")
  );
}

// The SDK returns a Node stream whose chunks are typed as strings or Buffers.
// Cancelling the web stream ends the iterator, which destroys the Node stream.
function toWebStream(
  stream: NodeJS.ReadableStream,
): ReadableStream<Uint8Array> {
  const chunks = stream[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(
        typeof next.value === "string"
          ? new TextEncoder().encode(next.value)
          : next.value,
      );
    },
    async cancel() {
      await chunks.return?.();
    },
  });
}
